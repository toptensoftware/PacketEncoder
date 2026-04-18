#include <stdio.h>
#include <string.h>
#include "packenc.h"

uint8_t packetData[] = {
0xaa, 0xaa, 0xaa, 0x0, 0x66, 0x3, 0x6, 0x0, 0x0, 0x0, 0x80, 0xaa, 0xaa, 0x0, 0x25, 0xc2, 0xca, 0x77, 0x55
};

struct decode_context ctx = {0};
uint8_t buf[4096];


void onPacket(uint32_t seq, uint32_t cmd, const void *pdata, uint32_t cbData)
{
    printf("PACKET: seq: %i cmd: %i data: %i bytes\n", (int)seq, (int)cmd, (int)cbData);
}

void onError(int code)
{
    printf("ERROR: %i\n", code);
}

void dump(uint8_t val)
{
    printf("0x%.2x, ", val);
}
int main()
{
    ctx.pBuf = buf;
    ctx.cbBuf = sizeof(buf);
    ctx.onPacket = onPacket;
    ctx.onError = onError;

    for (size_t i=0; i<sizeof(packetData); i++)
    {
        packet_decode(&ctx, packetData[i]);
    }

   //packet_encode(dump, 0, data, sizeof(data));
   printf("\n");

    return 0;
}