import type { CapacitorConfig } from '@capacitor/cli';

// EDIT THIS before building the Android app: your MAXIS server's LAN address
// (whatever you'd type into a browser on the shop WiFi to reach the site today,
// e.g. "http://192.168.1.50" or "http://maxis-server.local"). No port needed if
// the server is reachable on 80 via Caddy; include one (":3000") if it's not.
const SERVER_URL = 'http://192.168.68.204:3000';

const config: CapacitorConfig = {
  appId: 'com.nemench.maxis',
  appName: 'MAXIS KOT',
  webDir: 'dist',
  server: {
    url: SERVER_URL,
    cleartext: true,
    androidScheme: 'http'
  }
};

export default config;
