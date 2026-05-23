import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import TurndownService from 'turndown';
import * as XLSX from 'xlsx-republish';
import * as yauzl from 'yauzl';

const execAsync = promisify(exec);

class ConversionService {
  constructor() {
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    this.libreOfficeQueue = Promise.resolve();
  }

  async wordToMarkdown(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.convertToHtml({ buffer });
      return { success: true, data: this.turndownService.turndown(result.value) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async wordToHtml(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          includeEmbeddedStyleMap: true,
          convertImage: mammoth.images.imgElement(async (image) => {
            const imageBuffer = await image.read('buffer');
            const contentType = image.contentType || 'image/png';
            const base64 = Buffer.from(imageBuffer).toString('base64');
            return { src: `data:${contentType};base64,${base64}` };
          }),
        }
      );
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.65;padding:24px;max-width:960px;margin:0 auto}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d7dde5;padding:8px 10px}</style></head><body>${result.value}</body></html>`;
      return { success: true, data: html };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async excelToJson(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const isCsv = filePath.toLowerCase().endsWith('.csv');
      let workbook;
      let sheetImages = {};

      if (isCsv) {
        workbook = XLSX.read(buffer.toString('utf-8'), { type: 'string' });
      } else {
        workbook = XLSX.read(buffer, { type: 'buffer' });
        sheetImages = await this.extractExcelImages(buffer);
      }

      const sheets = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) || [];
        return {
          name,
          data,
          merges: sheet['!merges'] || [],
          images: sheetImages[name] || [],
        };
      });

      return { success: true, data: { sheets } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async pptToJson(filePath) {
    try {
      const fileBuffer = await fs.readFile(filePath);
      if (fileBuffer.length < 4 || fileBuffer.toString('ascii', 0, 2) !== 'PK') {
        return { success: false, error: 'Invalid PPTX file: missing PK signature' };
      }
      const zipEntries = await this.loadPptxZipEntries(fileBuffer);
      const mediaResources = {};
      const imageRelsMap = new Map();

      for (const [entryPath, buffer] of zipEntries.entries()) {
        if (entryPath.includes('_rels') && entryPath.endsWith('.rels')) {
          const relDoc = new DOMParser().parseFromString(buffer.toString('utf-8'), 'text/xml');
          const relationships = relDoc.getElementsByTagName('Relationship');
          for (let i = 0; i < relationships.length; i++) {
            const rel = relationships.item(i);
            if (!rel) continue;
            const type = rel.getAttribute('Type') || '';
            const target = rel.getAttribute('Target') || '';
            const id = rel.getAttribute('Id') || '';
            if (type.includes('image') && target && id) {
              imageRelsMap.set(id, target.replace(/^.*media\//, ''));
            }
          }
        }
        if (entryPath.startsWith('ppt/media/')) {
          const fileName = entryPath.replace('ppt/media/', '');
          mediaResources[fileName] = `data:${this.getMimeTypeFromName(fileName)};base64,${buffer.toString('base64')}`;
        }
      }

      const slides = [];
      for (const [entryPath, buffer] of zipEntries.entries()) {
        if (!entryPath.match(/^ppt\/slides\/slide\d+\.xml$/i)) continue;
        const slideNumber = parseInt(entryPath.match(/slide(\d+)\.xml$/i)?.[1] || '0', 10);
        const slideDoc = new DOMParser().parseFromString(buffer.toString('utf-8'), 'text/xml');
        slides.push({ slideNumber, content: this.parseSlideXml(slideDoc, imageRelsMap) });
      }
      slides.sort((a, b) => a.slideNumber - b.slideNumber);
      slides.forEach((slide, index) => {
        slide.slideNumber = index + 1;
      });

      return {
        success: true,
        data: {
          slides,
          raw: {
            _mediaResources: mediaResources,
            _slideCount: slides.length,
          },
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  parseSlideXml(xmlDoc, imageRelsMap) {
    const elements = [];
    const allElements = xmlDoc.getElementsByTagName('*');
    for (let i = 0; i < allElements.length; i++) {
      const node = allElements.item(i);
      if (!node) continue;
      const nodeName = node.nodeName;
      if (nodeName.endsWith(':sp') || nodeName === 'sp') {
        const textFrame = node.getElementsByTagNameNS('*', 'txBody')[0] || node.getElementsByTagName('txBody')[0];
        if (textFrame) {
          const paragraphs = textFrame.getElementsByTagNameNS('*', 'p');
          let text = '';
          for (let j = 0; j < paragraphs.length; j++) {
            const para = paragraphs.item(j);
            if (!para) continue;
            const runs = para.getElementsByTagNameNS('*', 'r');
            let paraText = '';
            for (let k = 0; k < runs.length; k++) {
              const run = runs.item(k);
              if (!run) continue;
              const textNodes = run.getElementsByTagNameNS('*', 't');
              for (let l = 0; l < textNodes.length; l++) {
                const textNode = textNodes.item(l);
                if (textNode?.textContent) paraText += textNode.textContent;
              }
            }
            if (paraText) text += `${paraText}\n`;
          }
          if (text.trim()) elements.push({ type: 'text', content: text.trim() });
        }
      }
      if (nodeName.endsWith(':pic') || nodeName === 'pic') {
        const blip = node.getElementsByTagNameNS('*', 'blip')[0] || node.getElementsByTagName('blip')[0];
        const embedId =
          blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ||
          blip?.getAttribute('r:embed') ||
          blip?.getAttribute('embed');
        if (!embedId) continue;
        const imageName = imageRelsMap.get(embedId);
        if (imageName) elements.push({ type: 'image', ref: imageName });
      }
    }
    return { elements };
  }

  async extractExcelImages(buffer) {
    try {
      const fileMap = await this.loadExcelZipEntries(buffer);
      const workbookXml = fileMap.get('xl/workbook.xml');
      if (!workbookXml) return {};
      const workbookRels = this.parseRelationships(fileMap.get('xl/_rels/workbook.xml.rels'));
      const workbookDoc = new DOMParser().parseFromString(workbookXml.toString('utf8'), 'text/xml');
      const sheetNodes = workbookDoc.getElementsByTagName('sheet');
      const sheetInfos = [];

      for (let i = 0; i < sheetNodes.length; i++) {
        const sheetNode = sheetNodes.item(i);
        if (!sheetNode) continue;
        const relId = sheetNode.getAttribute('r:id') || sheetNode.getAttribute('Id') || sheetNode.getAttribute('id');
        const name = sheetNode.getAttribute('name') || `Sheet${i + 1}`;
        if (!relId) continue;
        const rel = workbookRels.get(relId);
        if (!rel) continue;
        const sheetPath = this.resolveZipPath('xl/workbook.xml', rel.target);
        if (sheetPath) sheetInfos.push({ name, path: sheetPath });
      }

      const parser = new DOMParser();
      const result = {};
      for (const sheetInfo of sheetInfos) {
        const sheetRelPath = this.getRelsPath(sheetInfo.path);
        const sheetRelXml = sheetRelPath ? fileMap.get(sheetRelPath) : null;
        if (!sheetRelXml) continue;
        const sheetRelMap = this.parseRelationships(sheetRelXml);
        const drawingRels = Array.from(sheetRelMap.values()).filter((rel) => rel.type === ConversionService.DRAWING_REL_TYPE);
        for (const drawingRel of drawingRels) {
          const drawingPath = this.resolveZipPath(sheetInfo.path, drawingRel.target);
          if (!drawingPath) continue;
          const drawingXml = fileMap.get(drawingPath);
          if (!drawingXml) continue;
          const drawingDoc = parser.parseFromString(drawingXml.toString('utf8'), 'text/xml');
          const anchors = this.parseDrawingAnchors(drawingDoc);
          const drawingRelMap = this.parseRelationships(fileMap.get(this.getRelsPath(drawingPath)));
          anchors.forEach((anchor) => {
            const relInfo = drawingRelMap.get(anchor.embedId);
            if (!relInfo) return;
            const imagePath = this.resolveZipPath(drawingPath, relInfo.target);
            if (!imagePath) return;
            const imageBuffer = fileMap.get(imagePath);
            if (!imageBuffer) return;
            const src = `data:${this.getMimeTypeFromName(imagePath)};base64,${imageBuffer.toString('base64')}`;
            (result[sheetInfo.name] ||= []).push({ row: anchor.row, col: anchor.col, src, width: anchor.width, height: anchor.height });
          });
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  parseDrawingAnchors(doc) {
    const anchors = [];
    ['xdr:twoCellAnchor', 'xdr:oneCellAnchor', 'xdr:absoluteAnchor', 'twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].forEach((tag) => {
      const nodes = doc.getElementsByTagName(tag);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes.item(i);
        if (node) anchors.push(node);
      }
    });

    const entries = [];
    anchors.forEach((anchor) => {
      const blip = this.findFirstChild(anchor, ['a:blip', 'pic:blip', 'blip']);
      const embedId = blip?.getAttribute('r:embed') || blip?.getAttribute('embed');
      if (!embedId) return;
      const fromNode = this.findFirstChild(anchor, ['xdr:from', 'from']);
      const row = this.safeParseInt(this.findFirstChild(fromNode, ['xdr:row', 'row'])?.textContent, 0);
      const col = this.safeParseInt(this.findFirstChild(fromNode, ['xdr:col', 'col'])?.textContent, 0);
      const sizeNode = this.findFirstChild(anchor, ['xdr:ext', 'a:ext', 'ext']);
      entries.push({
        row,
        col,
        embedId,
        width: this.safeSize(sizeNode?.getAttribute('cx')),
        height: this.safeSize(sizeNode?.getAttribute('cy')),
      });
    });
    return entries;
  }

  async libreOfficeToPdf(filePath, outputDir) {
    try {
      await fs.access(filePath);
      const libreOfficePath = await this.findLibreOffice();
      if (!libreOfficePath) {
        return { success: false, error: 'LibreOffice is not installed or not found in PATH' };
      }

      const ext = path.extname(filePath).toLowerCase();
      const supportedExtensions = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.odp', '.ods'];
      if (!supportedExtensions.includes(ext)) {
        return { success: false, error: `Unsupported file extension: ${ext}` };
      }

      const tempDir = outputDir || path.join(os.tmpdir(), `moss-libreoffice-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });

      let sourcePath = filePath;
      let baseName = path.basename(filePath, ext);
      if (process.platform === 'darwin') {
        const tempFile = path.join(tempDir, `input${ext}`);
        await fs.copyFile(filePath, tempFile);
        sourcePath = tempFile;
        baseName = 'input';
      }

      if (['.xls', '.xlsx', '.ods'].includes(ext)) {
        const preparedPath = await this.prepareExcelForPdf(sourcePath, tempDir);
        if (preparedPath !== sourcePath) {
          sourcePath = preparedPath;
          baseName = path.basename(preparedPath, path.extname(preparedPath));
        }
      }

      return await new Promise((resolve) => {
        this.libreOfficeQueue = this.libreOfficeQueue.then(async () => {
          try {
            resolve(await this.executeLibreOfficeConversion(sourcePath, tempDir, baseName, ext));
          } catch (error) {
            resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
          }
        });
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async prepareExcelForPdf(filePath, tempDir) {
    if (path.extname(filePath).toLowerCase() !== '.xlsx') return filePath;
    try {
      const buffer = await fs.readFile(filePath);
      const zip = await JSZip.loadAsync(buffer);
      let maxColumns = 0;
      try {
        const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: 100 });
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet['!ref']) return;
          const range = XLSX.utils.decode_range(sheet['!ref']);
          maxColumns = Math.max(maxColumns, range.e.c - range.s.c + 1);
        });
      } catch {
        maxColumns = 5;
      }
      const orientation = maxColumns > 4 ? 'landscape' : 'portrait';
      const sheetFiles = Object.keys(zip.files).filter((name) => name.match(/^xl\/worksheets\/sheet\d+\.xml$/i));
      for (const sheetFile of sheetFiles) {
        const xmlContent = await zip.file(sheetFile).async('string');
        zip.file(sheetFile, this.injectPageSetupIntoSheetXml(xmlContent, orientation));
      }
      const preparedPath = path.join(tempDir, `prepared-${Date.now()}.xlsx`);
      await fs.writeFile(preparedPath, await zip.generateAsync({ type: 'nodebuffer' }));
      return preparedPath;
    } catch {
      return filePath;
    }
  }

  injectPageSetupIntoSheetXml(xmlContent, orientation) {
    try {
      const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
      const worksheet = doc.documentElement;
      if (!worksheet) return xmlContent;
      const ns = worksheet.namespaceURI || 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
      let sheetPr = worksheet.getElementsByTagNameNS(ns, 'sheetPr').item(0);
      if (!sheetPr) {
        sheetPr = doc.createElementNS(ns, 'sheetPr');
        const sheetData = worksheet.getElementsByTagNameNS(ns, 'sheetData').item(0);
        if (sheetData) worksheet.insertBefore(sheetPr, sheetData);
        else worksheet.appendChild(sheetPr);
      }
      let pageSetUpPr = null;
      for (let i = 0; i < sheetPr.childNodes.length; i++) {
        const child = sheetPr.childNodes.item(i);
        if (child?.nodeName === 'pageSetUpPr') pageSetUpPr = child;
      }
      if (!pageSetUpPr) {
        pageSetUpPr = doc.createElementNS(ns, 'pageSetUpPr');
        sheetPr.appendChild(pageSetUpPr);
      }
      pageSetUpPr.setAttribute('fitToPage', '1');
      let pageSetup = worksheet.getElementsByTagNameNS(ns, 'pageSetup').item(0);
      if (!pageSetup) {
        pageSetup = doc.createElementNS(ns, 'pageSetup');
        worksheet.appendChild(pageSetup);
      }
      pageSetup.setAttribute('fitToWidth', '1');
      pageSetup.setAttribute('fitToHeight', '0');
      pageSetup.setAttribute('orientation', orientation);
      pageSetup.setAttribute('paperSize', '9');

      let pageMargins = worksheet.getElementsByTagNameNS(ns, 'pageMargins').item(0);
      if (!pageMargins) {
        pageMargins = doc.createElementNS(ns, 'pageMargins');
        worksheet.insertBefore(pageMargins, pageSetup);
        const margin = orientation === 'landscape' ? '0.4' : '0.7';
        pageMargins.setAttribute('left', margin);
        pageMargins.setAttribute('right', margin);
        pageMargins.setAttribute('top', '0.5');
        pageMargins.setAttribute('bottom', '0.5');
        pageMargins.setAttribute('header', '0.3');
        pageMargins.setAttribute('footer', '0.3');
      }
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return xmlContent;
    }
  }

  async executeLibreOfficeConversion(sourcePath, tempDir, baseName, ext) {
    const libreOfficePath = await this.findLibreOffice();
    if (!libreOfficePath) return { success: false, error: 'LibreOffice is not installed or not found in PATH' };
    let pdfFilter = 'pdf';
    if (['.xls', '.xlsx', '.ods'].includes(ext)) pdfFilter = 'calc_pdf_Export';
    else if (['.doc', '.docx', '.odt'].includes(ext)) pdfFilter = 'writer_pdf_Export';
    else if (['.ppt', '.pptx', '.odp'].includes(ext)) pdfFilter = 'impress_pdf_Export';

    const command = `"${libreOfficePath}" --headless --norestore --nofirststartwizard --convert-to pdf:${pdfFilter} --outdir "${tempDir}" "${sourcePath}"`;
    await execAsync(command, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const files = await fs.readdir(tempDir);
    const directPath = path.join(tempDir, `${baseName}.pdf`);
    try {
      await fs.access(directPath);
      return { success: true, data: await fs.realpath(directPath) };
    } catch {}
    const fallback = files.find((file) => file.toLowerCase().endsWith('.pdf'));
    if (!fallback) return { success: false, error: 'PDF file was not created by LibreOffice' };
    return { success: true, data: await fs.realpath(path.join(tempDir, fallback)) };
  }

  async findLibreOffice() {
    try {
      const { stdout } = await execAsync('soffice --version');
      if (stdout) return 'soffice';
    } catch {}
    const candidates = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/soffice',
      '/opt/libreoffice/program/soffice',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      '/usr/bin/soffice',
      '/snap/bin/libreoffice',
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
    return null;
  }

  async isLibreOfficeAvailable() {
    return Boolean(await this.findLibreOffice());
  }

  parseRelationships(buffer) {
    const map = new Map();
    if (!buffer) return map;
    const doc = new DOMParser().parseFromString(buffer.toString('utf8'), 'text/xml');
    const relationships = doc.getElementsByTagName('Relationship');
    for (let i = 0; i < relationships.length; i++) {
      const relationship = relationships.item(i);
      if (!relationship) continue;
      const id = relationship.getAttribute('Id');
      const target = relationship.getAttribute('Target');
      if (!id || !target) continue;
      map.set(id, { target, type: relationship.getAttribute('Type') || '' });
    }
    return map;
  }

  getRelsPath(filePath) {
    if (!filePath) return null;
    const dirname = path.posix.dirname(filePath);
    const basename = path.posix.basename(filePath);
    return path.posix.join(dirname, '_rels', `${basename}.rels`);
  }

  resolveZipPath(fromPath, target) {
    if (!target) return null;
    return path.posix.normalize(path.posix.resolve(path.posix.dirname(fromPath), target.replace(/^\/+/, '')));
  }

  normalizeZipPath(fileName) {
    return fileName.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  async loadPptxZipEntries(buffer) {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(error || new Error('Failed to open PPTX zip'));
        const map = new Map();
        zip.on('entry', (entry) => {
          const normalizedPath = this.normalizeZipPath(entry.fileName);
          if (normalizedPath.endsWith('/')) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return reject(streamError || new Error('Failed to read PPTX entry'));
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              map.set(normalizedPath, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolve(map));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }

  async loadExcelZipEntries(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const fileMap = new Map();
    await Promise.all(
      Object.keys(zip.files).map(async (name) => {
        const file = zip.file(name);
        if (!file || file.dir) return;
        fileMap.set(this.normalizeZipPath(name), Buffer.from(await file.async('nodebuffer')));
      })
    );
    return fileMap;
  }

  findFirstChild(node, tags) {
    if (!node) return null;
    for (const tag of tags) {
      const children = node.getElementsByTagName(tag);
      const child = children.item(0);
      if (child) return child;
    }
    return null;
  }

  safeParseInt(value, fallback) {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  safeSize(value) {
    const parsed = this.safeParseInt(value, 0);
    return parsed > 0 ? Math.round(parsed / 9525) : undefined;
  }

  getMimeTypeFromName(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const map = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    };
    return map[ext] || 'application/octet-stream';
  }
}

ConversionService.DRAWING_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';

export const conversionService = new ConversionService();
