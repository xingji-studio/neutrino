export function wcwidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 1;

  // Combining / zero-width marks (width 0)
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    (cp >= 0x0711 && cp <= 0x0711) ||
    (cp >= 0x0730 && cp <= 0x074a) ||
    (cp >= 0x07a6 && cp <= 0x07b0) ||
    (cp >= 0x07eb && cp <= 0x07f3) ||
    (cp >= 0x0816 && cp <= 0x0819) ||
    (cp >= 0x081b && cp <= 0x0823) ||
    (cp >= 0x0825 && cp <= 0x0827) ||
    (cp >= 0x0829 && cp <= 0x082d) ||
    (cp >= 0x0859 && cp <= 0x085b) ||
    (cp >= 0x08d3 && cp <= 0x08e1) ||
    (cp >= 0x08e3 && cp <= 0x0902) ||
    (cp >= 0x093a && cp <= 0x093a) ||
    (cp >= 0x093c && cp <= 0x093c) ||
    (cp >= 0x0941 && cp <= 0x0948) ||
    (cp >= 0x094d && cp <= 0x094d) ||
    (cp >= 0x0951 && cp <= 0x0957) ||
    (cp >= 0x0962 && cp <= 0x0963) ||
    (cp >= 0x0981 && cp <= 0x0981) ||
    (cp >= 0x09bc && cp <= 0x09bc) ||
    (cp >= 0x09c1 && cp <= 0x09c4) ||
    (cp >= 0x09cd && cp <= 0x09cd) ||
    (cp >= 0x09e2 && cp <= 0x09e3) ||
    (cp >= 0x0a01 && cp <= 0x0a02) ||
    (cp >= 0x0a3c && cp <= 0x0a3c) ||
    (cp >= 0x0a41 && cp <= 0x0a42) ||
    (cp >= 0x0a47 && cp <= 0x0a48) ||
    (cp >= 0x0a4b && cp <= 0x0a4d) ||
    (cp >= 0x0a51 && cp <= 0x0a51) ||
    (cp >= 0x0a70 && cp <= 0x0a71) ||
    (cp >= 0x0a75 && cp <= 0x0a75) ||
    (cp >= 0x0a81 && cp <= 0x0a82) ||
    (cp >= 0x0abc && cp <= 0x0abc) ||
    (cp >= 0x0ac1 && cp <= 0x0ac5) ||
    (cp >= 0x0ac7 && cp <= 0x0ac8) ||
    (cp >= 0x0acd && cp <= 0x0acd) ||
    (cp >= 0x0ae2 && cp <= 0x0ae3) ||
    (cp >= 0x0b01 && cp <= 0x0b01) ||
    (cp >= 0x0b3c && cp <= 0x0b3c) ||
    (cp >= 0x0b3f && cp <= 0x0b3f) ||
    (cp >= 0x0b41 && cp <= 0x0b44) ||
    (cp >= 0x0b4d && cp <= 0x0b4d) ||
    (cp >= 0x0b56 && cp <= 0x0b56) ||
    (cp >= 0x0b62 && cp <= 0x0b63) ||
    (cp >= 0x0b82 && cp <= 0x0b82) ||
    (cp >= 0x0bc0 && cp <= 0x0bc0) ||
    (cp >= 0x0bcd && cp <= 0x0bcd) ||
    (cp >= 0x0c00 && cp <= 0x0c00) ||
    (cp >= 0x0c3e && cp <= 0x0c40) ||
    (cp >= 0x0c46 && cp <= 0x0c48) ||
    (cp >= 0x0c4a && cp <= 0x0c4d) ||
    (cp >= 0x0c55 && cp <= 0x0c56) ||
    (cp >= 0x0c62 && cp <= 0x0c63) ||
    (cp >= 0x0c81 && cp <= 0x0c81) ||
    (cp >= 0x0cbc && cp <= 0x0cbc) ||
    (cp >= 0x0cbf && cp <= 0x0cbf) ||
    (cp >= 0x0cc6 && cp <= 0x0cc6) ||
    (cp >= 0x0ccc && cp <= 0x0ccd) ||
    (cp >= 0x0ce2 && cp <= 0x0ce3) ||
    (cp >= 0x0d00 && cp <= 0x0d01) ||
    (cp >= 0x0d3b && cp <= 0x0d3c) ||
    (cp >= 0x0d41 && cp <= 0x0d44) ||
    (cp >= 0x0d4d && cp <= 0x0d4d) ||
    (cp >= 0x0d62 && cp <= 0x0d63) ||
    (cp >= 0x0dca && cp <= 0x0dca) ||
    (cp >= 0x0dd2 && cp <= 0x0dd4) ||
    (cp >= 0x0dd6 && cp <= 0x0dd6) ||
    (cp >= 0x0e31 && cp <= 0x0e31) ||
    (cp >= 0x0e34 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x0eb1 && cp <= 0x0eb1) ||
    (cp >= 0x0eb4 && cp <= 0x0eb9) ||
    (cp >= 0x0ebb && cp <= 0x0ebc) ||
    (cp >= 0x0ec8 && cp <= 0x0ecd) ||
    (cp >= 0x0f18 && cp <= 0x0f19) ||
    (cp >= 0x0f35 && cp <= 0x0f35) ||
    (cp >= 0x0f37 && cp <= 0x0f37) ||
    (cp >= 0x0f39 && cp <= 0x0f39) ||
    (cp >= 0x0f71 && cp <= 0x0f7e) ||
    (cp >= 0x0f80 && cp <= 0x0f84) ||
    (cp >= 0x0f86 && cp <= 0x0f87) ||
    (cp >= 0x0f8d && cp <= 0x0f97) ||
    (cp >= 0x0f99 && cp <= 0x0fbc) ||
    (cp >= 0x0fc6 && cp <= 0x0fc6) ||
    (cp >= 0x102d && cp <= 0x1030) ||
    (cp >= 0x1032 && cp <= 0x1037) ||
    (cp >= 0x1039 && cp <= 0x103a) ||
    (cp >= 0x103d && cp <= 0x103e) ||
    (cp >= 0x1058 && cp <= 0x1059) ||
    (cp >= 0x105e && cp <= 0x1060) ||
    (cp >= 0x1071 && cp <= 0x1074) ||
    (cp >= 0x1082 && cp <= 0x1082) ||
    (cp >= 0x1085 && cp <= 0x1086) ||
    (cp >= 0x108d && cp <= 0x108d) ||
    (cp >= 0x109d && cp <= 0x109d) ||
    (cp >= 0x135d && cp <= 0x135f) ||
    (cp >= 0x1712 && cp <= 0x1714) ||
    (cp >= 0x1732 && cp <= 0x1734) ||
    (cp >= 0x1752 && cp <= 0x1753) ||
    (cp >= 0x1772 && cp <= 0x1773) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x17b7 && cp <= 0x17bd) ||
    (cp >= 0x17c6 && cp <= 0x17c6) ||
    (cp >= 0x17c9 && cp <= 0x17d3) ||
    (cp >= 0x17dd && cp <= 0x17dd) ||
    (cp >= 0x180b && cp <= 0x180e) ||
    (cp >= 0x1885 && cp <= 0x1886) ||
    (cp >= 0x18a9 && cp <= 0x18a9) ||
    (cp >= 0x1920 && cp <= 0x1922) ||
    (cp >= 0x1927 && cp <= 0x1928) ||
    (cp >= 0x1932 && cp <= 0x1932) ||
    (cp >= 0x1939 && cp <= 0x193b) ||
    (cp >= 0x1a17 && cp <= 0x1a18) ||
    (cp >= 0x1a1b && cp <= 0x1a1b) ||
    (cp >= 0x1a56 && cp <= 0x1a56) ||
    (cp >= 0x1a58 && cp <= 0x1a5e) ||
    (cp >= 0x1a60 && cp <= 0x1a60) ||
    (cp >= 0x1a62 && cp <= 0x1a62) ||
    (cp >= 0x1a65 && cp <= 0x1a6c) ||
    (cp >= 0x1a73 && cp <= 0x1a7c) ||
    (cp >= 0x1a7f && cp <= 0x1a7f) ||
    (cp >= 0x1ab0 && cp <= 0x1abe) ||
    (cp >= 0x1b00 && cp <= 0x1b03) ||
    (cp >= 0x1b34 && cp <= 0x1b34) ||
    (cp >= 0x1b36 && cp <= 0x1b3a) ||
    (cp >= 0x1b3c && cp <= 0x1b3c) ||
    (cp >= 0x1b42 && cp <= 0x1b42) ||
    (cp >= 0x1b6b && cp <= 0x1b73) ||
    (cp >= 0x1b80 && cp <= 0x1b81) ||
    (cp >= 0x1ba2 && cp <= 0x1ba5) ||
    (cp >= 0x1ba8 && cp <= 0x1ba9) ||
    (cp >= 0x1bab && cp <= 0x1bad) ||
    (cp >= 0x1be6 && cp <= 0x1be6) ||
    (cp >= 0x1be8 && cp <= 0x1be9) ||
    (cp >= 0x1bed && cp <= 0x1bed) ||
    (cp >= 0x1bef && cp <= 0x1bf1) ||
    (cp >= 0x1c2c && cp <= 0x1c33) ||
    (cp >= 0x1c36 && cp <= 0x1c37) ||
    (cp >= 0x1cd0 && cp <= 0x1cd2) ||
    (cp >= 0x1cd4 && cp <= 0x1ce0) ||
    (cp >= 0x1ce2 && cp <= 0x1ce8) ||
    (cp >= 0x1ced && cp <= 0x1ced) ||
    (cp >= 0x1cf4 && cp <= 0x1cf4) ||
    (cp >= 0x1cf8 && cp <= 0x1cf9) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0x2cef && cp <= 0x2cf1) ||
    (cp >= 0x2d7f && cp <= 0x2d7f) ||
    (cp >= 0x2de0 && cp <= 0x2dff) ||
    (cp >= 0x302a && cp <= 0x302d) ||
    (cp >= 0x3099 && cp <= 0x309a) ||
    (cp >= 0xa66f && cp <= 0xa672) ||
    (cp >= 0xa674 && cp <= 0xa67d) ||
    (cp >= 0xa69e && cp <= 0xa69f) ||
    (cp >= 0xa6f0 && cp <= 0xa6f1) ||
    (cp >= 0xa802 && cp <= 0xa802) ||
    (cp >= 0xa806 && cp <= 0xa806) ||
    (cp >= 0xa80b && cp <= 0xa80b) ||
    (cp >= 0xa825 && cp <= 0xa826) ||
    (cp >= 0xa8c4 && cp <= 0xa8c5) ||
    (cp >= 0xa8e0 && cp <= 0xa8f1) ||
    (cp >= 0xa926 && cp <= 0xa92d) ||
    (cp >= 0xa947 && cp <= 0xa951) ||
    (cp >= 0xa980 && cp <= 0xa982) ||
    (cp >= 0xa9b3 && cp <= 0xa9b3) ||
    (cp >= 0xa9b6 && cp <= 0xa9b9) ||
    (cp >= 0xa9bc && cp <= 0xa9bc) ||
    (cp >= 0xa9e5 && cp <= 0xa9e5) ||
    (cp >= 0xaa29 && cp <= 0xaa2e) ||
    (cp >= 0xaa31 && cp <= 0xaa32) ||
    (cp >= 0xaa35 && cp <= 0xaa36) ||
    (cp >= 0xaa43 && cp <= 0xaa43) ||
    (cp >= 0xaa4c && cp <= 0xaa4c) ||
    (cp >= 0xaa7c && cp <= 0xaa7c) ||
    (cp >= 0xaab0 && cp <= 0xaab0) ||
    (cp >= 0xaab2 && cp <= 0xaab4) ||
    (cp >= 0xaab7 && cp <= 0xaab8) ||
    (cp >= 0xaabe && cp <= 0xaabf) ||
    (cp >= 0xaac1 && cp <= 0xaac1) ||
    (cp >= 0xaaec && cp <= 0xaaed) ||
    (cp >= 0xaaf6 && cp <= 0xaaf6) ||
    (cp >= 0xabe5 && cp <= 0xabe5) ||
    (cp >= 0xabe8 && cp <= 0xabe8) ||
    (cp >= 0xabed && cp <= 0xabed) ||
    (cp >= 0xfb1e && cp <= 0xfb1e) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x101fd && cp <= 0x101fd) ||
    (cp >= 0x102e0 && cp <= 0x102e0) ||
    (cp >= 0x10376 && cp <= 0x1037a) ||
    (cp >= 0x10a01 && cp <= 0x10a03) ||
    (cp >= 0x10a05 && cp <= 0x10a06) ||
    (cp >= 0x10a0c && cp <= 0x10a0f) ||
    (cp >= 0x10a38 && cp <= 0x10a3a) ||
    (cp >= 0x10a3f && cp <= 0x10a3f) ||
    (cp >= 0x10ae5 && cp <= 0x10ae6) ||
    (cp >= 0x11001 && cp <= 0x11001) ||
    (cp >= 0x11038 && cp <= 0x11046) ||
    (cp >= 0x1107f && cp <= 0x11081) ||
    (cp >= 0x110b3 && cp <= 0x110b6) ||
    (cp >= 0x110b9 && cp <= 0x110ba) ||
    (cp >= 0x11100 && cp <= 0x11102) ||
    (cp >= 0x11127 && cp <= 0x1112b) ||
    (cp >= 0x1112d && cp <= 0x11134) ||
    (cp >= 0x11173 && cp <= 0x11173) ||
    (cp >= 0x11180 && cp <= 0x11181) ||
    (cp >= 0x111b6 && cp <= 0x111be) ||
    (cp >= 0x1122f && cp <= 0x11231) ||
    (cp >= 0x11234 && cp <= 0x11234) ||
    (cp >= 0x11236 && cp <= 0x11237) ||
    (cp >= 0x1123e && cp <= 0x1123e) ||
    (cp >= 0x112df && cp <= 0x112df) ||
    (cp >= 0x112e3 && cp <= 0x112ea) ||
    (cp >= 0x11300 && cp <= 0x11301) ||
    (cp >= 0x1133c && cp <= 0x1133c) ||
    (cp >= 0x11340 && cp <= 0x11340) ||
    (cp >= 0x11366 && cp <= 0x1136c) ||
    (cp >= 0x11370 && cp <= 0x11374) ||
    (cp >= 0x11438 && cp <= 0x1143f) ||
    (cp >= 0x11442 && cp <= 0x11444) ||
    (cp >= 0x11446 && cp <= 0x11446) ||
    (cp >= 0x114b3 && cp <= 0x114b8) ||
    (cp >= 0x114ba && cp <= 0x114ba) ||
    (cp >= 0x114bf && cp <= 0x114c0) ||
    (cp >= 0x114c2 && cp <= 0x114c3) ||
    (cp >= 0x115b2 && cp <= 0x115b5) ||
    (cp >= 0x115bc && cp <= 0x115bd) ||
    (cp >= 0x115bf && cp <= 0x115c0) ||
    (cp >= 0x115dc && cp <= 0x115dd) ||
    (cp >= 0x11633 && cp <= 0x1163a) ||
    (cp >= 0x1163d && cp <= 0x1163d) ||
    (cp >= 0x1163f && cp <= 0x11640) ||
    (cp >= 0x116ab && cp <= 0x116ab) ||
    (cp >= 0x116ad && cp <= 0x116ad) ||
    (cp >= 0x116b0 && cp <= 0x116b5) ||
    (cp >= 0x116b7 && cp <= 0x116b7) ||
    (cp >= 0x1171d && cp <= 0x1171f) ||
    (cp >= 0x11722 && cp <= 0x11725) ||
    (cp >= 0x11727 && cp <= 0x1172b) ||
    (cp >= 0x11c30 && cp <= 0x11c36) ||
    (cp >= 0x11c38 && cp <= 0x11c3d) ||
    (cp >= 0x11c3f && cp <= 0x11c3f) ||
    (cp >= 0x11c92 && cp <= 0x11ca7) ||
    (cp >= 0x11caa && cp <= 0x11cb0) ||
    (cp >= 0x11cb2 && cp <= 0x11cb3) ||
    (cp >= 0x11cb5 && cp <= 0x11cb6) ||
    (cp >= 0x16af0 && cp <= 0x16af4) ||
    (cp >= 0x16b30 && cp <= 0x16b36) ||
    (cp >= 0x1bc9d && cp <= 0x1bc9e) ||
    (cp >= 0x1d165 && cp <= 0x1d169) ||
    (cp >= 0x1d16d && cp <= 0x1d182) ||
    (cp >= 0x1d185 && cp <= 0x1d18b) ||
    (cp >= 0x1d1aa && cp <= 0x1d1ad) ||
    (cp >= 0x1d242 && cp <= 0x1d244) ||
    (cp >= 0x1e000 && cp <= 0x1e006) ||
    (cp >= 0x1e008 && cp <= 0x1e018) ||
    (cp >= 0x1e01b && cp <= 0x1e021) ||
    (cp >= 0x1e023 && cp <= 0x1e024) ||
    (cp >= 0x1e026 && cp <= 0x1e02a) ||
    (cp >= 0x1e8d0 && cp <= 0x1e8d6) ||
    (cp >= 0x1e944 && cp <= 0x1e94a)
  ) {
    return 0;
  }

  // Wide (double-width) characters
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x3105 && cp <= 0x312f) ||
    (cp >= 0x3131 && cp <= 0x318e) ||
    (cp >= 0x3190 && cp <= 0x31ba) ||
    (cp >= 0x31c0 && cp <= 0x31e3) ||
    (cp >= 0x31f0 && cp <= 0x321e) ||
    (cp >= 0x3220 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0x32fe) ||
    (cp >= 0x3300 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa48c) ||
    (cp >= 0xa490 && cp <= 0xa4c6) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe52) ||
    (cp >= 0xfe54 && cp <= 0xfe66) ||
    (cp >= 0xfe68 && cp <= 0xfe6b) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x16fe1) ||
    (cp >= 0x17000 && cp <= 0x187f7) ||
    (cp >= 0x18800 && cp <= 0x18cd5) ||
    (cp >= 0x1b000 && cp <= 0x1b152) ||
    (cp >= 0x1b164 && cp <= 0x1b167) ||
    (cp >= 0x1b170 && cp <= 0x1b2fb) ||
    (cp >= 0x1f004 && cp <= 0x1f004) ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f202) ||
    (cp >= 0x1f210 && cp <= 0x1f23b) ||
    (cp >= 0x1f240 && cp <= 0x1f248) ||
    (cp >= 0x1f250 && cp <= 0x1f251) ||
    (cp >= 0x1f260 && cp <= 0x1f265) ||
    (cp >= 0x1f300 && cp <= 0x1f320) ||
    (cp >= 0x1f32d && cp <= 0x1f335) ||
    (cp >= 0x1f337 && cp <= 0x1f37c) ||
    (cp >= 0x1f37e && cp <= 0x1f393) ||
    (cp >= 0x1f3a0 && cp <= 0x1f3ca) ||
    (cp >= 0x1f3cf && cp <= 0x1f3d3) ||
    (cp >= 0x1f3e0 && cp <= 0x1f3f0) ||
    cp === 0x1f3f4 ||
    (cp >= 0x1f3f8 && cp <= 0x1f43e) ||
    cp === 0x1f440 ||
    (cp >= 0x1f442 && cp <= 0x1f4fc) ||
    (cp >= 0x1f4ff && cp <= 0x1f53d) ||
    (cp >= 0x1f54b && cp <= 0x1f54e) ||
    (cp >= 0x1f550 && cp <= 0x1f567) ||
    cp === 0x1f57a ||
    (cp >= 0x1f595 && cp <= 0x1f596) ||
    cp === 0x1f5a4 ||
    (cp >= 0x1f5fb && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6c5) ||
    cp === 0x1f6cc ||
    (cp >= 0x1f6d0 && cp <= 0x1f6d2) ||
    (cp >= 0x1f6d5 && cp <= 0x1f6d7) ||
    (cp >= 0x1f6eb && cp <= 0x1f6ec) ||
    (cp >= 0x1f6f4 && cp <= 0x1f6fc) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f93a) ||
    (cp >= 0x1f93c && cp <= 0x1f945) ||
    (cp >= 0x1f947 && cp <= 0x1f978) ||
    (cp >= 0x1f97a && cp <= 0x1f9cb) ||
    (cp >= 0x1f9cd && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1fa74) ||
    (cp >= 0x1fa78 && cp <= 0x1fa7a) ||
    (cp >= 0x1fa80 && cp <= 0x1fa86) ||
    (cp >= 0x1fa90 && cp <= 0x1faa8) ||
    (cp >= 0x1fab0 && cp <= 0x1fab6) ||
    (cp >= 0x1fac0 && cp <= 0x1fac2) ||
    (cp >= 0x1fad0 && cp <= 0x1fad6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += wcwidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

export function truncateByWidth(text: string, width: number): string {
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = wcwidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

export function ellipsize(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  return truncateByWidth(text, width - 1) + "…";
}
