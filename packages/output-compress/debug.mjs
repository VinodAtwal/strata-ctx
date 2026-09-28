import { serializeToon, parseToon } from './src/index.js';
import { NASTY_STRINGS } from './test/fixtures.js';

const rows = NASTY_STRINGS.map((s, i) => ({ i, s }));
const text = serializeToon(rows);
console.log('Serialized:');
console.log(text);
console.log('---');
try {
  const back = parseToon(text);
  console.log('Parsed successfully');
  NASTY_STRINGS.forEach((s, i) => {
    if (back[i]?.s !== s) {
      console.log(`Mismatch at ${i}: expected ${JSON.stringify(s)}, got ${JSON.stringify(back[i]?.s)}`);
    }
  });
} catch (e) {
  console.log('Parse error:', e.message);
}
