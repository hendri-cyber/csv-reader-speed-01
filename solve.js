// csv-reader-speed-01: drop-in replacement for csv-reader 1.0.0 (make.fun).
// Same answers for every input, pure JS, no WASM / native addon / prebuilt binary.
// Strategy (regex variant): one global-char-class test() per delimiter finds
// the earliest of , \r \n (unquoted) or " \r \n (quoted) in a single scan,
// so no separate \r check is ever needed: the first delimiter found decides.
// The state machine mirrors vendor/csv-reader/index.js exactly (same records,
// fields, errors, line/row numbering).
//
// Field results travel in closure out-vars (outValue/outEnded/outAdded).
// Call nesting is at most readQuoted -> readUnquoted, and each level consumes
// the out-vars before returning, so they are never clobbered.
//
// Conventions (same as the reference):
//   ended: 0 = comma (record goes on), 1 = line break (record ends), 2 = end.
//   errors are {code, line, row} with line = the record's start line (1-based)
//   and row = the record's index in rows (null for the header); short_row adds
//   `fields`, long_row adds `extra`. Result is {columns, rows, errors}.

const QUOTE = 34; // "
const COMMA = 44; // ,
const LF = 10; // \n
const CR = 13; // \r

/** Next delimiter of an unquoted field: comma, CR or LF. */
const DELIM = /[,\r\n]/g;
/** Next interesting character inside a quoted field: quote, CR or LF. */
const QDELIM = /["\r\n]/g;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Field-result out-vars (see header note).
  let outValue = '';
  let outEnded = 0;
  let outAdded = 0;

  // Read an unquoted field starting at pos, with initial value v and `added`
  // kept characters already counted in v. Sets outValue/outEnded/outAdded.
  // `added` counts only characters appended during this read (the quote_junk
  // test). rl/rr are the current record's line/row for stray_cr errors.
  function readUnquoted(v, added, rl, rr) {
    for (;;) {
      DELIM.lastIndex = pos;
      if (!DELIM.test(text)) {
        // No delimiter to the end of the text. The rest may hold stray CRs
        // (no comma or LF is left, so every CR here is stray).
        const seg = text.slice(pos);
        if (seg.indexOf('\r') === -1) {
          outValue = v + seg;
          outAdded = added + seg.length;
          pos = n;
          outEnded = 2;
          return;
        }
        let k = 0;
        for (;;) {
          const ri = seg.indexOf('\r', k);
          if (ri === -1) {
            if (seg.length > k) {
              v += seg.slice(k);
              added += seg.length - k;
            }
            break;
          }
          if (ri > k) {
            v += seg.slice(k, ri);
            added += ri - k;
          }
          errors.push({ code: 'stray_cr', line: rl, row: rr });
          k = ri + 1;
        }
        outValue = v;
        outAdded = added;
        pos = n;
        outEnded = 2;
        return;
      }
      const idx = DELIM.lastIndex - 1;
      const ch = text.charCodeAt(idx);
      if (ch === COMMA) {
        outValue = v + text.slice(pos, idx);
        outAdded = added + (idx - pos);
        pos = idx + 1;
        outEnded = 0;
        return;
      }
      if (ch === LF) {
        outValue = v + text.slice(pos, idx);
        outAdded = added + (idx - pos);
        pos = idx + 1;
        line++;
        outEnded = 1;
        return;
      }
      // ch === CR.
      if (text.charCodeAt(idx + 1) === LF) {
        // CRLF: ends the field as a line break.
        outValue = v + text.slice(pos, idx);
        outAdded = added + (idx - pos);
        pos = idx + 2;
        line++;
        outEnded = 1;
        return;
      }
      // Stray CR: error, drop it, keep scanning for the field's end.
      errors.push({ code: 'stray_cr', line: rl, row: rr });
      v += text.slice(pos, idx);
      added += idx - pos;
      pos = idx + 1;
    }
  }

  // Read a quoted field whose opening quote is at pos. Sets outValue/outEnded.
  function readQuoted(rl, rr) {
    const open = pos;
    const openLine = line;
    let v = '';
    pos += 1;
    let start = pos;
    for (;;) {
      QDELIM.lastIndex = start;
      if (!QDELIM.test(text)) {
        // No quote or line break to the end: the quote never closes. It is
        // a literal character, and the text after it is read again as an
        // unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: rl, row: rr });
        readUnquoted('"', 1, rl, rr);
        return;
      }
      const idx = QDELIM.lastIndex - 1;
      const ch = text.charCodeAt(idx);
      if (ch === QUOTE) {
        if (text.charCodeAt(idx + 1) === QUOTE) {
          // Doubled quote inside: one quote in the value, keep scanning.
          v += text.slice(start, idx) + '"';
          start = idx + 2;
          continue;
        }
        // Closing quote.
        v += text.slice(start, idx);
        pos = idx + 1;
        break;
      }
      if (ch === LF) {
        v += text.slice(start, idx + 1);
        line++;
        start = idx + 1;
        continue;
      }
      // CR inside quotes: CRLF and lone CR each become one LF.
      if (text.charCodeAt(idx + 1) === LF) {
        v += text.slice(start, idx) + '\n';
        line++;
        start = idx + 2;
        continue;
      }
      v += text.slice(start, idx) + '\n';
      line++;
      start = idx + 1;
    }
    if (pos >= n) {
      outValue = v;
      outEnded = 2;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      outValue = v;
      outEnded = 0;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      outValue = v;
      outEnded = 1;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      outValue = v;
      outEnded = 1;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break (quote_junk when the field ends, if any junk
    // characters were appended).
    readUnquoted(v, 0, rl, rr);
    if (outAdded > 0) errors.push({ code: 'quote_junk', line: rl, row: rr });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === QUOTE;
      if (lastQuoted) readQuoted(recordLine, recordRow);
      else readUnquoted('', 0, recordLine, recordRow);
      fields.push(outValue);
    } while (outEnded === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
