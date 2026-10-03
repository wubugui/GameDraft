/**
 * JSON / 纯文本装载器(移植自 PixiJS v8.17(MIT):`assets/loader/parsers/loadJson`、`loadTxt`)。
 */
import { DOMAdapter } from '../../../environment/adapter';
import { checkDataUrl, checkExtension } from '../../utils/helpers';
import { LoaderParserPriority, type LoaderParser, type ResolvedAsset } from '../../types';

const validJSONExtension = '.json';
const validJSONMIME = 'application/json';

export const loadJson: LoaderParser = {
  extension: {
    type: 'load-parser',
    priority: LoaderParserPriority.Low,
  },
  name: 'loadJson',
  id: 'json',
  test(url: string): boolean {
    return checkDataUrl(url, validJSONMIME) || checkExtension(url, validJSONExtension);
  },
  async load(url: string, asset?: ResolvedAsset): Promise<unknown> {
    const response = await DOMAdapter.get().fetch(url, { signal: asset?.requestSignal });
    if (!response.ok) throw new Error(`JSON fetch failed ${response.status}: ${url}`);
    const json = await response.json();
    return json;
  },
};

const validTXTExtension = '.txt';
const validTXTMIME = 'text/plain';

export const loadTxt: LoaderParser = {
  name: 'loadTxt',
  id: 'text',
  extension: {
    type: 'load-parser',
    priority: LoaderParserPriority.Low,
    name: 'loadTxt',
  },
  test(url: string): boolean {
    return checkDataUrl(url, validTXTMIME) || checkExtension(url, validTXTExtension);
  },
  async load(url: string, asset?: ResolvedAsset): Promise<string> {
    const response = await DOMAdapter.get().fetch(url, { signal: asset?.requestSignal });
    if (!response.ok) throw new Error(`Text fetch failed ${response.status}: ${url}`);
    const txt = await response.text();
    return txt;
  },
};
