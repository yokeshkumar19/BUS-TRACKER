import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rit.bustracker',
  appName: 'BUS TRACKER',
  webDir: 'dist',

  android: {
    useLegacyBridge: true,
  },
};

export default config;