// usage: node cut.cjs <file> <startMarker> <endMarker> <replacementFile>
// Replaces the text from startMarker (inclusive) up to endMarker (exclusive).
const fs = require('node:fs');
const [file, start, end, replacementFile] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const a = text.indexOf(start);
const b = end === '<EOF>' ? text.length : text.indexOf(end, a + 1);
if (a < 0 || b < 0) {
	console.error(`marker not found: ${a} ${b}`);
	process.exit(1);
}
const replacement = replacementFile ? fs.readFileSync(replacementFile, 'utf8') : '';
fs.writeFileSync(file, text.slice(0, a) + replacement + text.slice(b));
console.log(`replaced ${b - a} chars`);
