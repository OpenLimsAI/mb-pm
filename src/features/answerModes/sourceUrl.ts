export function safeWebSourceUrl(value: string) {
  try {
    // URL normalizes unusual numeric spellings such as 0x7f.0.0.1 before validation.
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !host.includes('.') || host === 'localhost' || ['.local', '.localhost', '.internal', '.test', '.invalid'].some(suffix => host.endsWith(suffix)) || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined
    return url.href
  } catch { return undefined }
}
