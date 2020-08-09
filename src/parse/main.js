import browser from 'webextension-polyfill';
import {uniqBy} from 'lodash-es';
import {v4 as uuidv4} from 'uuid';

import storage from 'storage/storage';
import {
  hasUrlSupport,
  validateUrl,
  normalizeFilename,
  normalizeImage,
  getImageElement
} from 'utils/app';
import {
  getBlankCanvasDataUrl,
  canvasToDataUrl,
  drawElementOnCanvas,
  getAbsoluteUrl
} from 'utils/common';
import {targetEnv} from 'utils/config';

const cssProperties = ['background-image', 'border-image-source', 'mask-image'];
const pseudoSelectors = ['::before', '::after'];
const replacedElements = ['img', 'video', 'iframe', 'embed'];
const rxCssUrl = /url\(['"]?([^'")]+)['"]?\)/gi;

function getFilenameExtFromUrl(url) {
  const file = url
    .split('/')
    .pop()
    .replace(/(?:#|\?).*?$/, '')
    .split('.');
  let filename = '';
  let ext = '';
  if (file.length === 1) {
    filename = file[0];
  } else {
    filename = file.join('.');
    ext = file.pop().toLowerCase();
  }

  return {filename, ext};
}

function fetchImage(url, {credentials = true, token = ''} = {}) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = 1200000; // 2 minutes
    xhr.responseType = 'blob';
    if (credentials) {
      xhr.withCredentials = true;
    }
    if (token) {
      xhr.setRequestHeader('x-sbi-token', token);
    }

    xhr.onload = () => {
      resolve(xhr);
    };
    xhr.onerror = () => {
      resolve();
    };
    xhr.onabort = () => {
      resolve();
    };
    xhr.ontimeout = () => {
      resolve();
    };

    xhr.send();
  });
}

function extractCSSImages(cssProps, node, pseudo = null) {
  if (pseudo) {
    cssProps = cssProps.slice();
    cssProps.push('content');
  }

  const images = [];
  const style = window.getComputedStyle(node, pseudo);

  let match;

  cssProperties.forEach(function (prop) {
    let value = style.getPropertyValue(prop);
    if (value && value !== 'none') {
      while ((match = rxCssUrl.exec(value)) !== null) {
        images.push({data: match[1]});
      }
    }
  });

  return images;
}

async function parseNode(node) {
  const results = [];
  const nodeName = node.nodeName.toLowerCase();
  let cssProps = cssProperties;

  if (nodeName === 'img') {
    if (node.currentSrc) {
      results.push({data: node.currentSrc});
    }
  }

  if (nodeName === 'image') {
    const url = node.getAttribute('href') || node.getAttribute('xlink:href');
    if (url) {
      const absUrl = getAbsoluteUrl(url);
      if (absUrl) {
        results.push({data: absUrl});
      }
    }
  }

  if (nodeName === 'embed') {
    const data = node.src;
    if (data && (await getImageElement(data))) {
      results.push({data});
    }
  }

  if (nodeName === 'object') {
    const data = node.data;
    if (data && (await getImageElement(data))) {
      results.push({data});
    }
  }

  if (nodeName === 'iframe') {
    const data = node.src;
    if (data && !node.srcdoc && (await getImageElement(data))) {
      results.push({data});
    }
  }

  if (nodeName === 'canvas') {
    const data = canvasToDataUrl(node, {clear: false});
    if (data && data !== getBlankCanvasDataUrl(node.width, node.height)) {
      results.push({data});
    }
  }

  if (nodeName === 'video') {
    if (node.readyState >= 2) {
      const cnv = document.createElement('canvas');
      const ctx = cnv.getContext('2d');
      cnv.width = node.videoWidth;
      cnv.height = node.videoHeight;

      if (drawElementOnCanvas(ctx, node)) {
        const data = canvasToDataUrl(cnv, {ctx});
        if (data) {
          results.push({data});
        }
      }
    }

    if (node.poster) {
      results.push({data: node.poster});
    }
  }

  if (nodeName === 'li') {
    cssProps = cssProps.slice();
    cssProps.push('list-style-image');
  }

  results.push(...extractCSSImages(cssProps, node));

  if (!replacedElements.includes(nodeName)) {
    pseudoSelectors.forEach(function (pseudo) {
      results.push(...extractCSSImages(cssProps, node, pseudo));
    });
  }

  return results;
}

async function parseDocument({root = null, touchRect = null} = {}) {
  const results = [];

  for (const currentNode of root.querySelectorAll('*')) {
    let nodeRect = currentNode.getBoundingClientRect();
    if (
      touchRect.bottom < nodeRect.top + window.scrollY ||
      touchRect.top > nodeRect.bottom + window.scrollY ||
      touchRect.left > nodeRect.right + window.scrollX ||
      touchRect.right < nodeRect.left + window.scrollX
    ) {
      continue;
    }

    results.push(...(await parseNode(currentNode)));

    const shadowRoot =
      currentNode.openOrClosedShadowRoot || currentNode.shadowRoot;

    if (shadowRoot) {
      results.push(...(await parseDocument({root: shadowRoot, touchRect})));
    }
  }

  return results;
}

async function parse() {
  if (typeof touchTarget === 'undefined' || !touchTarget.node) {
    throw new Error('Touch target missing');
  }

  let results = [];
  const targetNode = touchTarget.node;

  const docNodeName = document.documentElement.nodeName.toLowerCase();
  if (docNodeName !== 'html' && docNodeName !== 'svg') {
    return results;
  }

  const touchRect = {
    bottom: touchTarget.uy + 24,
    top: touchTarget.uy - 24,
    left: touchTarget.ux - 24,
    right: touchTarget.ux + 24
  };

  results.push(...(await parseNode(targetNode)));

  const options = await storage.get(
    ['imgFullParse', 'searchModeAction', 'searchModeContextMenu'],
    'sync'
  );

  if (targetNode.nodeName.toLowerCase() !== 'img' || options.imgFullParse) {
    results.push(
      ...(await parseDocument({root: document, touchRect})).reverse()
    );
  }

  results = uniqBy(results, 'data');

  const daraUrls = results.filter(item => item.data.startsWith('data:'));
  for (const item of daraUrls) {
    const index = results.indexOf(item);
    const {data, ext} = await normalizeImage({dataUrl: item.data});
    if (data) {
      results[index] = {data, filename: normalizeFilename({ext})};
    } else {
      results.splice(index, 1);
    }
  }

  const isLocalDoc = window.location.href.startsWith('file://');
  if (isLocalDoc) {
    const fileUrls = results.filter(item => item.data.startsWith('file://'));
    if (fileUrls.length) {
      const cnv = document.createElement('canvas');
      const ctx = cnv.getContext('2d');
      for (const item of fileUrls) {
        const url = item.data;
        const img = await getImageElement(url);
        if (img) {
          let {filename, ext} = getFilenameExtFromUrl(url);
          const type = ['jpg', 'jpeg', 'jpe'].includes(ext)
            ? 'image/jpeg'
            : 'image/png';
          cnv.width = img.naturalWidth;
          cnv.height = img.naturalHeight;

          if (drawElementOnCanvas(ctx, img)) {
            const data = canvasToDataUrl(cnv, {ctx, type});
            if (data) {
              filename = normalizeFilename({filename, ext});
              results[results.indexOf(item)] = {data, filename};
            }
          }
        }
      }
    }
  }

  const blobUrls = results.filter(item => item.data.startsWith('blob:'));
  if (blobUrls.length) {
    const cnv = document.createElement('canvas');
    const ctx = cnv.getContext('2d');
    const filename = normalizeFilename({ext: 'png'});
    for (const item of blobUrls) {
      const img = await getImageElement(item.data);
      if (img) {
        cnv.width = img.naturalWidth;
        cnv.height = img.naturalHeight;

        if (drawElementOnCanvas(ctx, img)) {
          const data = canvasToDataUrl(cnv, {ctx});
          if (data) {
            results[results.indexOf(item)] = {data, filename};
          }
        }
      }
    }
  }

  const searchMode =
    frameStore.data.eventOrigin === 'action'
      ? options.searchModeAction
      : options.searchModeContextMenu;
  const mustUpload = searchMode === 'selectUpload';
  const urlSupport = await hasUrlSupport(frameStore.data.engine);

  const httpUrls = results.filter(item => validateUrl(item.data));
  if (httpUrls.length) {
    for (const item of httpUrls) {
      const index = results.indexOf(item);
      const url = item.data;
      if (mustUpload || !urlSupport) {
        let rsp;
        if (targetEnv === 'firefox') {
          const token = uuidv4();
          await browser.runtime.sendMessage({
            id: 'setRequestReferrer',
            referrer: window.location.href,
            token,
            url
          });
          rsp = await fetchImage(url, {token});
        } else {
          rsp = await fetchImage(url);
        }

        if (!rsp || !rsp.response) {
          results.splice(index, 1);
          continue;
        }

        const {data, ext} = await normalizeImage({blob: rsp.response});
        if (data) {
          let {filename} = getFilenameExtFromUrl(url);
          filename = normalizeFilename({filename, ext});
          results[index] = {url, data, filename, mustUpload};
        } else {
          results.splice(index, 1);
        }
      } else {
        results[index] = {url};
      }
    }
  }

  return results.filter(item => validateSearchItem(item));
}

function validateSearchItem(item) {
  if (item.data && !item.data.startsWith('data:')) {
    return false;
  }

  return true;
}

self.initParse = async function initParse() {
  const images = await parse().catch(err => {
    console.log(err.toString());
    browser.runtime.sendMessage({
      id: 'pageParseError'
    });
  });
  if (images) {
    browser.runtime.sendMessage({
      id: 'pageParseSubmit',
      engine: frameStore.data.engine,
      images
    });
  }
};
