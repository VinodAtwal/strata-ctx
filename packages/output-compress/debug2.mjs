import { serializeToon, parseToon } from './src/index.js';
import { COMPOSITE_VALUES } from './test/fixtures.js';

console.log('COMPOSITE_VALUES:', COMPOSITE_VALUES);
console.log('Length:', COMPOSITE_VALUES.length);

// Test with the problematic composite value
const value = COMPOSITE_VALUES[9]; // { 'quote"key': 'new\nline' }
console.log('Original value:', JSON.stringify(value));

const rows = [{ a: value }];
const text = serializeToon(rows);
console.log('Serialized:');
console.log(text);

try {
  const back = parseToon(text);
  console.log('Parsed successfully:', JSON.stringify(back));
} catch (e) {
  console.log('Parse error:', e.message);
}
