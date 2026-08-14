// Fetch rejects a small set of ports even for loopback URLs. Some operating
// systems can hand one of them back for listen(0), so retry before exposing a
// mock server URL to fetch-based clients.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address && typeof address !== 'string' && !FETCH_BLOCKED_PORTS.has(address.port)) {
      return address;
    }
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error('Unable to allocate a fetch-safe loopback port');
}
