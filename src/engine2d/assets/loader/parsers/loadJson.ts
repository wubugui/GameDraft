/**
 * JSON / 纯文本装载器(移植自 PixiJS v8.17(MIT):`assets/loader/parsers/loadJson`、`loadTxt`)。
 */
import { DOMAdapter } from '../../../environment/adapter';
import { checkDataUrl, checkExtension } from '../../utils/helpers';
import { LoaderParserPriority, type LoaderParser } from '../../types';

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
  async load(url: string): Promise<unknown> {
    const response = await DOMAdapter.get().fetch(url);
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
  async load(url: string): Promise<string> {
    const response = await DOMAdapter.get().fetch(url);
    const txt = await response.text();
    return txt;
  },
};
