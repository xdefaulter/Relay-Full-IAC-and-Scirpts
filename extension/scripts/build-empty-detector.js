const fs = require("fs");
const path = require("path");

const NEEDLE = "\"workOpportunities\":[]";
const NEEDLE_LEN = Buffer.byteLength(NEEDLE, "utf8");
const PATTERN_OFFSET = 131072;
const SCRATCH_SIZE = 65536;

const outPath = path.join(__dirname, "..", "wasm", "empty_detector.wasm");

function encodeU32(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return bytes;
}

function encodeVec(bytes) {
  return [...encodeU32(bytes.length), ...bytes];
}

function encodeString(str) {
  const buf = Buffer.from(str, "utf8");
  return [...encodeU32(buf.length), ...buf];
}

function funcType(params, results) {
  return [0x60, ...encodeVec(params), ...encodeVec(results)];
}

function section(id, data) {
  return [id, ...encodeU32(data.length), ...data];
}

function encodeLocals(count, type) {
  if (count === 0) return [0x00];
  return [0x01, ...encodeU32(count), type];
}

function buildModule() {
  const moduleBytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // Type section
  const types = [
    funcType([], [0x7f]),
    funcType([0x7f, 0x7f], [0x7f])
  ];
  moduleBytes.push(...section(1, encodeVec(types.flat())));

  // Function section
  const funcTypes = [0, 0, 1];
  moduleBytes.push(...section(3, encodeVec(funcTypes.map((idx) => encodeU32(idx)).flat())));

  // Memory section
  const memEntry = [
    0x01, // count
    0x01, // limits: min & max
    ...encodeU32(3), // min pages
    ...encodeU32(3)  // max pages
  ];
  moduleBytes.push(...section(5, memEntry));

  // Export section
  const exports = [
    [...encodeString("memory"), 0x02, 0x00],
    [...encodeString("get_scratch_ptr"), 0x00, 0x00],
    [...encodeString("get_scratch_size"), 0x00, 0x01],
    [...encodeString("scan_empty"), 0x00, 0x02]
  ];
  moduleBytes.push(...section(7, encodeVec(exports.flat())));

  // Data section
  const dataSegment = [
    0x01, // count
    0x00, // active, memidx 0
    0x41, ...encodeU32(PATTERN_OFFSET), 0x0b, // offset expr
    ...encodeVec([...Buffer.from(NEEDLE, "utf8")])
  ];
  moduleBytes.push(...section(11, dataSegment));

  // Code section
  const codeBodies = [
    buildGetPtrBody(),
    buildGetSizeBody(),
    buildScanBody()
  ];
  moduleBytes.push(...section(10, encodeVec(codeBodies.flat())));

  return Buffer.from(moduleBytes);
}

function buildGetPtrBody() {
  const body = [
    0x41, 0x00, // i32.const 0
    0x0b        // end
  ];
  return [0x04, 0x00, ...body];
}

function buildGetSizeBody() {
  const sizeBytes = encodeU32(SCRATCH_SIZE);
  const body = [
    0x41, ...sizeBytes,
    0x0b
  ];
  const bodySize = 1 + sizeBytes.length + 1;
  return [bodySize + 1, 0x00, ...body];
}

function buildScanBody() {
  const body = [];
  // locals: i, j, limit
  const locals = [0x01, ...encodeU32(3), 0x7f];

  // if len < NEEDLE_LEN return 0
  body.push(
    0x20, 0x01,             // local.get 1
    0x41, ...encodeU32(NEEDLE_LEN),
    0x49,                   // i32.lt_u
    0x04, 0x40,             // if
    0x41, 0x00,             //   i32.const 0
    0x0f,                   //   return
    0x0b                    // end if
  );

  // limit = len - NEEDLE_LEN
  body.push(
    0x20, 0x01,             // local.get 1
    0x41, ...encodeU32(NEEDLE_LEN),
    0x6b,                   // i32.sub
    0x21, 0x04              // local.set 4
  );

  // block $exit
  body.push(0x02, 0x40);
  // loop $outer
  body.push(0x03, 0x40);
  // if (i > limit) break
  body.push(
    0x20, 0x02,             // local.get i
    0x20, 0x04,             // local.get limit
    0x4f,                   // i32.gt_u
    0x0d, 0x01              // br_if depth=1 (exit block)
  );
  // j = 0
  body.push(0x41, 0x00, 0x21, 0x03);

  // block $next
  body.push(0x02, 0x40);
  // loop $inner
  body.push(0x03, 0x40);
  // if (j >= NEEDLE_LEN) return 1
  body.push(
    0x20, 0x03,
    0x41, ...encodeU32(NEEDLE_LEN),
    0x4d,                   // i32.ge_u
    0x04, 0x40,
    0x41, 0x01,
    0x0f,
    0x0b
  );
  // load buffer byte
  body.push(
    0x20, 0x00,             // local.get ptr
    0x20, 0x02,             // local.get i
    0x6a,                   // add
    0x20, 0x03,             // local.get j
    0x6a,                   // add
    0x2d, 0x00, 0x00        // i32.load8_u align=0 offset=0
  );
  // load needle byte
  body.push(
    0x41, ...encodeU32(PATTERN_OFFSET),
    0x20, 0x03,
    0x6a,
    0x2d, 0x00, 0x00
  );
  // compare
  body.push(
    0x47,                   // i32.ne
    0x0d, 0x01              // br_if depth=1 -> block $next
  );
  // j++
  body.push(
    0x20, 0x03,
    0x41, 0x01,
    0x6a,
    0x21, 0x03,
    0x0c, 0x00              // br loop $inner
  );
  // end loop $inner, block $next
  body.push(0x0b, 0x0b);

  // i++
  body.push(
    0x20, 0x02,
    0x41, 0x01,
    0x6a,
    0x21, 0x02,
    0x0c, 0x00              // br loop $outer
  );
  // end loop and block
  body.push(0x0b, 0x0b);

  // return 0
  body.push(0x41, 0x00, 0x0f, 0x0b);

  const sizeBytes = encodeU32(locals.length + body.length);
  return [...sizeBytes, ...locals, ...body];
}

const buffer = buildModule();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buffer);
console.log(`Wrote ${outPath} (${buffer.length} bytes)`);
