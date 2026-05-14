import cn from '../locales/langs/cn.json';

type ServerToolLocaleKey = keyof typeof cn;

export function serverToolT(key: ServerToolLocaleKey) {
  return cn[key] || key;
}
