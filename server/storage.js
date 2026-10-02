const fs = require('fs');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@_' };

const jsonFile = (dir, id) => path.join(dir, `${id}.json`);
const xmlFile  = (dir, id) => path.join(dir, `${id}.xml`);

const cleanItems = items => (items ?? []).map(i => String(i).trim()).filter(Boolean);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeList(dir, id, items, format) {
  const clean = cleanItems(items);
  const updatedAt = new Date().toISOString();

  if (format === 'xml') {
    const builder = new XMLBuilder({ ...XML_OPTS, format: true, indentBy: '  ', suppressEmptyNode: true });
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      builder.build({
        list: { '@_platform': id, '@_updatedAt': updatedAt, items: { item: clean } }
      });
    fs.writeFileSync(xmlFile(dir, id), xml, 'utf8');
    try { fs.unlinkSync(jsonFile(dir, id)); } catch { /* not there */ }
  } else {
    fs.writeFileSync(
      jsonFile(dir, id),
      JSON.stringify({ platform: id, items: clean, updatedAt }, null, 2),
      'utf8'
    );
    try { fs.unlinkSync(xmlFile(dir, id)); } catch { /* not there */ }
  }

  return { platform: id, format, items: clean, updatedAt };
}

function readList(dir, id, preferredFormat) {
  const order = preferredFormat === 'xml' ? ['xml', 'json'] : ['json', 'xml'];

  for (const format of order) {
    try {
      if (format === 'json') {
        const parsed = JSON.parse(fs.readFileSync(jsonFile(dir, id), 'utf8'));
        return { platform: id, format, items: cleanItems(parsed.items), updatedAt: parsed.updatedAt ?? null };
      } else {
        const raw = fs.readFileSync(xmlFile(dir, id), 'utf8');
        const parsed = new XMLParser(XML_OPTS).parse(raw);
        let items = parsed?.list?.items?.item ?? [];
        if (!Array.isArray(items)) items = [items];
        return { platform: id, format, items: cleanItems(items), updatedAt: parsed?.list?.['@_updatedAt'] ?? null };
      }
    } catch { /* file missing/broken — try the other format */ }
  }
  return { platform: id, format: preferredFormat, items: [], updatedAt: null };
}

module.exports = { XML_OPTS, jsonFile, xmlFile, cleanItems, ensureDir, writeList, readList };