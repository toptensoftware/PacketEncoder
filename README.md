# PacketEncoder

A small, dependency-free library for sending **packets** of data reliably over a
**byte stream**, such as a UART/serial link between two microcontrollers, or
between a microcontroller and a PC.

A raw serial link just delivers bytes. It has no idea where one message ends
and the next begins, and it gives you no protection against bytes that get
dropped, corrupted or injected (line noise, a device resetting mid-transfer,
a receiver that starts listening halfway through a message, and so on).
PacketEncoder adds a lightweight framing layer on top of the stream so that
the receiver can:

- find the start of each packet, even if it joins the stream mid-way
- recover automatically after garbage or lost bytes
- detect corrupted packets using a CRC-32 checksum and discard them
- receive a sequence number, a command code and a payload with each packet

The library comes in two matching implementations that produce and accept
exactly the same wire format:

| File                       | Language   | Typical use                             |
|----------------------------|------------|-----------------------------------------|
| `packenc.c` / `packenc.h`  | C (C99)    | Firmware on the MCU (also usable on PC) |
| `crc32.c` / `crc32.h`      | C (C99)    | CRC-32 used by the C implementation     |
| `packenc.js`               | JavaScript | Node.js host side (ES module)           |
| `crc32.js`                 | JavaScript | CRC-32 used by the JS implementation    |

Both the encoder and the decoder are **streaming**: the encoder emits one byte
at a time through a callback, and the decoder is fed one byte at a time. This
makes it easy to plug directly into a UART transmit routine or a receive
interrupt/handler, with no need to buffer a whole encoded frame.

---

## Packet format

Each packet carries three pieces of information:

- **`seq`** - a 32-bit sequence number (meaning is up to you; typically used to
  match replies to requests or detect lost packets)
- **`cmd`** - a 32-bit command/message type code (again, meaning is up to you)
- **`data`** - a payload of zero or more bytes

On the wire a packet looks like this:

```
+----------+-----------+-------+-------+--------+----------+---------+------------+
| AA AA AA |    00     |  seq  |  cmd  | length |   data   |  CRC32  |     55     |
|  signal  | separator | varlen| varlen| varlen | <length> | 4 bytes | terminator |
+----------+-----------+-------+-------+--------+----------+---------+------------+
            \_____________________ byte-stuffed ________________________/
            \____________ covered by the CRC ____________/
```

| Field        | Size        | Description                                                   |
|--------------|-------------|---------------------------------------------------------------|
| Signal       | 3 bytes     | Always `AA AA AA`. Marks the start of a packet.               |
| Separator    | 1 byte      | Always `00`.                                                  |
| `seq`        | 1-5 bytes   | Sequence number, variable-length encoded.                    |
| `cmd`        | 1-5 bytes   | Command code, variable-length encoded.                       |
| `length`     | 1-5 bytes   | Number of payload bytes, variable-length encoded.            |
| Data         | `length`    | The payload bytes, unmodified apart from byte stuffing.      |
| CRC32        | 4 bytes     | CRC-32 of everything from the separator to the end of data, big-endian (most significant byte first). |
| Terminator   | 1 byte      | Always `55`. Marks the end of a packet.                       |

### The start signal and byte stuffing

The receiver recognises the start of a packet by seeing **three consecutive
`0xAA` bytes**. For this to be reliable, that sequence must never appear
inside a packet. The encoder guarantees this with *byte stuffing*:

> Inside a packet (separator through CRC), whenever two `0xAA` bytes are
> written in a row, the encoder immediately inserts an extra `0x00`
> "stuff" byte.

So payload bytes `AA AA AA AA` go out on the wire as `AA AA 00 AA AA 00`.
The decoder does the reverse: after two consecutive `0xAA` bytes it expects a
`0x00`, which it silently drops. If it sees anything other than `0x00` or a
third `0xAA` at that point, the data is invalid and the current packet is
discarded.

Because stuffing makes `AA AA AA` impossible inside a frame, the decoder can
watch for the signal **at all times**, even while it is in the middle of
receiving a packet. If a new signal arrives before the current packet is
complete (for example because the sender reset, or bytes were lost), the
partial packet is discarded and decoding restarts on the new one. This is
what lets the link resynchronise on its own.

Stuffing costs at most one extra byte for every two `0xAA` bytes, and nothing
at all for data that doesn't contain `AA AA`.

Notes:

- The stuff bytes are included in the CRC calculation (the CRC is computed
  over the bytes as they appear on the wire, not the original data).
- Stuffing is also applied to the CRC bytes, but stuff bytes that appear
  inside the CRC field are, of course, not part of the CRC itself.
- The signal and terminator are written directly and are not stuffed.

### Variable-length integers

`seq`, `cmd` and `length` are encoded as big-endian base-128 integers
(most significant group first), 7 bits per byte. Every byte except the last
has its top bit (`0x80`) set; the last byte has it clear.

| Value        | Encoded bytes       |
|--------------|---------------------|
| `0`          | `00`                |
| `127`        | `7F`                |
| `128`        | `81 00`             |
| `300`        | `82 2C`             |
| `0xFFFFFFFF` | `8F FF FF FF 7F`    |

Small values (under 128), which is the common case for command codes and short
payloads, take a single byte.

### CRC-32

The checksum is the standard CRC-32 (polynomial `0x04C11DB7`, reflected,
initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`), i.e. the same CRC used by
Ethernet, ZIP and zlib's `crc32()`. It is transmitted most significant byte
first. A table-driven implementation is included (`crc32.c` / `crc32.js`); the
256-entry table is generated on first use.

### Worked example

Encoding `seq = 300`, `cmd = 1`, `data = "hello"` produces:

```
AA AA AA              signal
00                    separator
82 2C                 seq = 300
01                    cmd = 1
05                    length = 5
68 65 6C 6C 6F        "hello"
03 78 FC 3A           CRC-32 = 0x0378FC3A
55                    terminator
```

An example with stuffing (`seq = 102`, `cmd = 3`, data `00 00 00 80 AA AA`):

```
AA AA AA  00  66  03  06  00 00 00 80 AA AA [00]  25 C2 CA 77  55
                                            ^ stuff byte
```

### Overhead

For a payload of `n` bytes, the framing overhead is:

- 3 (signal) + 1 (separator) + 4 (CRC) + 1 (terminator) = **9 bytes**, plus
- 1-5 bytes each for `seq`, `cmd` and `length` (3 bytes when all are < 128), plus
- 1 byte for every `AA AA` pair in the stuffed region.

So a typical small packet costs about 12 bytes of overhead.

---

## How the decoder works

The decoder is a byte-at-a-time state machine:

```
waiting_signal ──(AA AA AA)──> expect_separator ──(00)──> expect_seq
     ^                                                        │
     │                                                        v
     │                         expect_length <────────── expect_cmd
     │                              │
     │                 length == 0  │  length > 0
     │              ┌───────────────┴───────────┐
     │              v                           v
     │         expect_crc <─────────────── expect_data
     │              │ (4 bytes, CRC ok)
     │              v
     └──(55)── expect_terminator ──> packet delivered
```

At every step, if something unexpected arrives (wrong separator, bad stuff
byte, payload too large for the receive buffer, CRC mismatch, missing
terminator), the packet is dropped, the optional error callback is told why,
and the decoder goes back to waiting for the next signal. Independently of
the state, three `0xAA` bytes in a row always start a fresh packet.

A packet is only delivered once the CRC has been checked **and** the
terminator has been seen, so your packet callback never receives partial or
corrupt data.

Note that the decoder only detects and drops bad packets. It doesn't
acknowledge or retransmit anything. If you need guaranteed delivery, build
that on top, e.g. using `seq` to match replies to requests and resending
on timeout.

---

## C API

Add `packenc.c`, `packenc.h`, `crc32.c` and `crc32.h` to your project. There
is no dynamic allocation; the decoder uses a receive buffer you supply.

### Encoding

```c
void packet_encode(void (*callback)(uint8_t data),
                   uint32_t seq, uint32_t cmd,
                   const void* pData, uint32_t cbData);
```

Encodes one packet and calls `callback` once for each output byte, in order.
`pData` may be `NULL` when `cbData` is 0.

```c
#include "packenc.h"

static void uart_send_byte(uint8_t b)
{
    // e.g. write to your UART, or append to a TX buffer
}

void send_reading(uint32_t seq, int16_t value)
{
    packet_encode(uart_send_byte, seq, /*cmd*/ 0x10, &value, sizeof(value));
}
```

### Decoding

```c
typedef struct
{
    // Internal state: zero-initialise before first use
    uint8_t  state;
    uint8_t  signal_bytes_seen;
    uint32_t count, seq, cmd, length, crcRecv, crcCalc;

    // Set these before decoding
    void (*onPacket)(uint32_t seq, uint32_t cmd, const void* pData, uint32_t cbData);
    void (*onError)(int code);   // optional, may be NULL
    uint8_t* pBuf;               // receive buffer for the payload
    size_t   cbBuf;              // size of pBuf = maximum payload accepted
} decode_context;

void packet_decode(decode_context* pctx, uint8_t data);
```

Create a `decode_context`, zero it, fill in the callbacks and buffer, then
pass every received byte to `packet_decode()`:

```c
#include <string.h>
#include "packenc.h"

static uint8_t rx_buf[256];
static decode_context rx;

static void on_packet(uint32_t seq, uint32_t cmd, const void* pData, uint32_t cbData)
{
    // pData points into rx_buf (or is NULL when cbData is 0).
    // Copy anything you need to keep: the buffer is reused for the next packet.
}

static void on_error(int code)
{
    // code is one of enum packet_error (see below)
}

void rx_init(void)
{
    memset(&rx, 0, sizeof(rx));
    rx.onPacket = on_packet;
    rx.onError  = on_error;
    rx.pBuf     = rx_buf;
    rx.cbBuf    = sizeof(rx_buf);
}

// Call for every byte received from the UART
void rx_byte(uint8_t b)
{
    packet_decode(&rx, b);
}
```

You can run several decoders at once (e.g. one per serial port) by giving
each its own `decode_context` and buffer.

`onPacket` is called from inside `packet_decode()`. If you feed the decoder
from an interrupt handler, keep the callback short, or queue the packet and
handle it in your main loop.

### Error codes

| Code | Name                                   | Meaning                                                      |
|------|----------------------------------------|--------------------------------------------------------------|
| 1    | `packet_error_new_packet`              | A new start signal arrived before the current packet finished. |
| 2    | `packet_error_invalid_stuff_byte`      | Two `0xAA` bytes were followed by something other than `0x00`. |
| 3    | `packet_error_invalid_separator_byte`  | The byte after the signal wasn't `0x00`.                     |
| 4    | `packet_error_too_large`               | The payload length is bigger than `cbBuf`.                   |
| 5    | `packet_error_checksum_mismatch`       | The CRC didn't match: the packet was corrupted.              |
| 6    | `packet_error_invalid_terminator`      | The byte after the CRC wasn't `0x55`.                        |

In every case the packet is discarded and the decoder resynchronises on the
next start signal.

### Memory footprint

- Decoder state: about 40 bytes per `decode_context` on a 32-bit MCU, plus your receive buffer.
- Encoder: a few bytes of stack per call (the variable-length encoder recurses
  at most 5 levels).
- CRC table: 1 KB of RAM (`256 x uint32_t`), shared, built on first use.

---

## JavaScript API

`packenc.js` is an ES module for Node.js (it uses `Buffer`).

```js
import { packet_encode, packet_decoder } from "./packenc.js";
```

### `packet_encode(callback, seq, cmd, buf)`

Encodes one packet, calling `callback(byte)` for each output byte. `buf` is a
`Buffer`, `Uint8Array` or array of byte values.

```js
const bytes = [];
packet_encode(b => bytes.push(b), 1, 0x10, Buffer.from("hello"));
port.write(Buffer.from(bytes));   // e.g. a serialport instance
```

### `packet_decoder(onPacket, onError, maxLength = 1024)`

Creates a decoder and returns a function to call with each received byte.

- `onPacket(seq, cmd, data)`: called for each valid packet; `data` is a
  `Buffer`
- `onError(message)`: optional; called with a text description when a packet
  is discarded
- `maxLength`: largest payload accepted (default 1024 bytes)

```js
const receive = packet_decoder(
    (seq, cmd, data) => console.log("packet", seq, cmd, data),
    (msg) => console.warn(msg),
    4096
);

port.on("data", chunk => {
    for (const b of chunk)
        receive(b);
});
```

`data` is a view into the decoder's internal buffer, which is reused for the
next packet. Copy it (`Buffer.from(data)`) if you need to keep it after the
callback returns.

### CRC helpers

`crc32.js` also exports `crc32_start()`, `crc32_update(crc, byte)`,
`crc32_finish(crc)`, `crc32_buffer(buf)` and `crc32_string(str)` if you need a
standard CRC-32 elsewhere. The C equivalents are in `crc32.h`.

---

## Tests

`test/main.c` decodes a sample packet (which includes a stuff byte) and prints
the result. Its `Makefile` relies on a shared build-rules file outside this
repository. To build it directly:

```sh
gcc -I. -o packtest test/main.c packenc.c crc32.c
./packtest
# PACKET: seq: 102 cmd: 3 data: 6 bytes
```

(At the moment `test/main.c` declares the context as `struct decode_context`,
which needs changing to `decode_context` before it will compile.)

---

## License

MIT. See [LICENSE](LICENSE).
