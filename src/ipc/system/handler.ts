import { os } from '@orpc/server';
import { z } from 'zod';
import { networkInterfaces } from 'os';

export const systemHandler = os.route({
  get_local_ip: os.handler(async () => {
    const nets = networkInterfaces();
    const results: string[] = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
          results.push(net.address);
        }
      }
    }
    return results.length > 0 ? results[0] : '127.0.0.1';
  }),
});
