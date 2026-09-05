import crypto from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sniffBillBytes(buf: Buffer): 'zip' | 'pdf' | 'ole' | 'csv' {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return 'ole';
  }
  return 'csv';
}

export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  const replacements = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacements === 0) return utf8.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return utf8;
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell.trim());
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let match: RegExpExecArray | null;
  while ((match = siRe.exec(xml))) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => xmlUnescape(item[1]));
    out.push(parts.join(''));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(cellXml: string, shared: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? '';
  if (type === 's') {
    const index = Number((cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '').trim());
    return Number.isInteger(index) ? (shared[index] ?? '') : '';
  }
  if (type === 'inlineStr' || type === 'str') {
    const text = cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/i)?.[1]
      ?? cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1]
      ?? '';
    return xmlUnescape(text);
  }
  const value = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '';
  return xmlUnescape(value);
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [...rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)];
    if (cells.length === 0) continue;
    const values: string[] = [];
    for (const cell of cells) {
      const attrs = cell[1];
      const body = cell[2];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? '';
      const index = colIndex(ref);
      while (values.length < index) values.push('');
      values[index] = cellText(`<c ${attrs}>${body}</c>`, shared);
    }
    if (values.some((value) => value !== '')) rows.push(values.map((value) => value.trim()));
  }
  return rows;
}

export function parseXlsx(buf: Buffer): string[][] {
  const files = unzipSync(new Uint8Array(buf));
  const names = Object.keys(files);
  const sharedName = names.find((name) => name.replace(/\\/g, '/').toLowerCase() === 'xl/sharedstrings.xml');
  const sheetName = names.find((name) => /xl\/worksheets\/sheet1\.xml$/i.test(name.replace(/\\/g, '/')));
  if (!sheetName) throw new Error('xlsx 里没有 sheet1，换 CSV 再导一次');
  const shared = sharedName ? parseSharedStrings(strFromU8(files[sharedName])) : [];
  return parseSheet(strFromU8(files[sheetName]), shared);
}

export function rowsFromBillFile(buf: Buffer): string[][] {
  const kind = sniffBillBytes(buf);
  if (kind === 'pdf') throw new Error('招行邮件 PDF 暂不解析，请在掌上生活或网银导出 CSV');
  if (kind === 'ole') throw new Error('旧版 .xls 不支持，另存为 xlsx 或 csv');
  if (kind === 'zip') return parseXlsx(buf);
  return parseCsv(decodeText(buf));
}
