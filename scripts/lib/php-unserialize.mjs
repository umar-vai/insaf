// Minimal PHP unserialize for WordPress meta values (arrays, strings, numbers,
// booleans, null). Objects are refused. String lengths are in UTF-8 bytes.
export function unserialize(input) {
  if (typeof input !== 'string' || !/^[aisbdN][:;]/.test(input)) return input;
  const buf = Buffer.from(input, 'utf8');
  let i = 0;
  const readUntil = (ch) => {
    const end = buf.indexOf(ch, i);
    if (end < 0) throw new Error('bad serialized value');
    const s = buf.toString('utf8', i, end);
    i = end + 1;
    return s;
  };
  const parse = () => {
    const type = String.fromCharCode(buf[i]);
    i += 2;
    switch (type) {
      case 'N':
        return null;
      case 'b':
        return readUntil(';') === '1';
      case 'i':
      case 'd':
        return Number(readUntil(';'));
      case 's': {
        const len = Number(readUntil(':'));
        const s = buf.toString('utf8', i + 1, i + 1 + len);
        i += len + 3;
        return s;
      }
      case 'a': {
        const n = Number(readUntil(':'));
        i += 1;
        const out = {};
        for (let k = 0; k < n; k++) {
          const key = parse();
          out[key] = parse();
        }
        i += 1;
        return out;
      }
      default:
        throw new Error(`unsupported serialized type ${type}`);
    }
  };
  try {
    return parse();
  } catch {
    return null;
  }
}
