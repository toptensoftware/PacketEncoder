import { crc32_start, crc32_finish, crc32_update } from "./crc32.js";

// Special bytes
const signal_byte = 0xAA;
const separator_byte = 0;
const stuff_byte = 0;
const terminator_byte = 0x55;

// Helper to variable length encode a value
function var_len_enc(value, callback, bit)
{
    if (value > 127)
    {
        var_len_enc(value >>> 7, callback, 0x80);
    }
    callback((value & 0x7F) | bit);
}

// Encode a single packet of data
export function packet_encode(callback, seq, cmd, buf)
{
    // Write signal
    callback(signal_byte);
    callback(signal_byte);
    callback(signal_byte);

    // Setup context
    let crc = crc32_start();
    let signal_bytes = 0;

    // Write header
    write(separator_byte);
    var_len_enc(seq, write);
    var_len_enc(cmd, write);
    var_len_enc(buf.length, write);

    // Write data
    for (let i = 0; i < buf.length  ; i++)
    {
        write(buf[i]);
    }

    // Write crc
    let crcResult = crc32_finish(crc);
    write((crcResult >>> 24) & 0xFF);
    write((crcResult >>> 16) & 0xFF);
    write((crcResult >>> 8) & 0xFF);
    write((crcResult >>> 0) & 0xFF);

    // Write terminator
    callback(terminator_byte);

    // Helper to write a byte of data to output stream, inserting
    // stuffing bytes and calculating CRC
    function write(data)
    {
        callback(data);
        crc = crc32_update(crc, data);

        if (data == signal_byte)
        {
            if (signal_bytes == 1)
            {
                // Write stuffing byte (0)
                data = stuff_byte;
                crc = crc32_update(crc, data);
                callback(data);
                signal_bytes = 0;
            }
            else
            {
                signal_bytes++;
            }
        }
        else
            signal_bytes = 0;
    }
}


export function packet_decoder(callback, error, maxlength)
{
    maxlength = maxlength || 1024;

    let state = "waiting_signal";
    let signal_bytes_seen = 0;
    let buf = Buffer.alloc(maxlength);
    let count;
    let seq;
    let cmd;
    let length;
    let crcRecv;
    let crcCalc;


    return function receive_byte(data)
    {
        // Monitoring for signal happens even while decoding packets
        // and if seen discards the current packet and starts a new one
        if (data == signal_byte)
        {
            if (signal_bytes_seen < 3)
                signal_bytes_seen++;
            if (signal_bytes_seen == 3)
            {
                // In middle of something else?
                if (state != "waiting_signal")
                {
                    error && error("packet discarded: new packet signal detected");
                }

                // Start new packet
                state = "expect_separator";
                count = 0;
                return;
            }
        }
        else
        {
            // Ignore zero byte after two consecutive signal_bytes
            if (signal_bytes_seen == 2)
            {
                signal_bytes_seen = 0;

                if (data != stuff_byte)
                {
                    error && error(`discarded packet: invalid stuff byte 0x${data.toString(16)}`);
                    state = "waiting_signal";
                }
                else if (state != "expect_crc" || count == 0)
                    crcCalc = crc32_update(crcCalc, data);
                return;
            }

            signal_bytes_seen = 0;
        }

        switch (state)
        {
        case "waiting_signal":
            // Still waiting for signal
            break;

        case "expect_separator":
            if (data != separator_byte)
            {
                error && error(`discarded packet: expected separator byte, received 0x${data.toString(16)}`);
                state = "waiting_signal";
            }
            else
            {
                state = "expect_seq";
                seq = 0;
                cmd = 0;
                crcCalc = crc32_start();
                crcCalc = crc32_update(crcCalc, data);
            }
            break;

        case "expect_seq":
            crcCalc = crc32_update(crcCalc, data);
            seq = ((seq << 7) | (data & 0x7f)) >>> 0;
            if ((data & 0x80) == 0)
            {
                state = "expect_cmd";
            }
            break;

        case "expect_cmd":
            crcCalc = crc32_update(crcCalc, data);
            cmd = ((cmd << 7) | (data & 0x7f)) >>> 0;
            if ((data & 0x80) == 0)
            {
                state = "expect_length";
                length = 0;
            }
            break;

        case "expect_length":
            crcCalc = crc32_update(crcCalc, data);
            length = ((length << 7) | (data & 0x7f)) >>> 0;
            if ((data & 0x80) == 0)
            {
                if (length > buf.length)
                {
                    error && error(`discarded packet: length exceeded limit (${length} > ${buf.length})`);
                    state = "waiting_signal";
                }
                else
                {
                    state = length == 0 ? "expect_crc" : "expect_data";
                    count = 0;
                }
            }
            break;

        case "expect_data":
            crcCalc = crc32_update(crcCalc, data);
            buf[count] = data;
            count++;
            if (count == length)
            {
                state = "expect_crc";
                count = 0;
            }
            break;

        case "expect_crc":
            crcRecv = (crcRecv << 8 | data) >>> 0;
            count++;
            if (count == 4)
            {
                crcCalc = crc32_finish(crcCalc);
                if (crcCalc != crcRecv)
                {
                    error && error(`discarded packet: checksum mismatch (recv: 0x${crcRecv.toString(16)} expected: 0x${crcCalc.toString(16)})`);
                    state = "waiting_signal";
                }
                else
                    state = "expect_terminator";
            }
            break;

        case "expect_terminator":
            if (data == terminator_byte)
            {
                state = "waiting_signal";
                callback(seq, cmd, buf.slice(0, length));
            }
            else
            {
                error && error(`discarded packet: missing terminator byte`);
                state = "waiting_signal";
            }
            break;
        }
    }
}


