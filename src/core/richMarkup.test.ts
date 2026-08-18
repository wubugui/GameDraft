import { extractMarkupImagePaths } from './richMarkup';

// parseRichMarkup 本体的块级语义由 src/ui/RichContent.test.ts 经再导出面覆盖;
// 这里只锁预热消费的抽取语义:拿到的必须是干净路径,且与渲染"会画哪些图"按构造一致。
describe('extractMarkupImagePaths (预热用插图路径抽取)', () => {
  it('剥掉 |wide/|full 档位后缀,只回路径段', () => {
    expect(extractMarkupImagePaths('[img:images/illustrations/a.png|wide]')).toEqual([
      'images/illustrations/a.png',
    ]);
    expect(extractMarkupImagePaths('前文[img:images/b.png|full]后文\n\n[img:images/c.png]')).toEqual([
      'images/b.png',
      'images/c.png',
    ]);
  });

  it('引文块内的 [img:] 渲染不认,抽取同样不认', () => {
    expect(extractMarkupImagePaths('[quote]文中[img:images/x.png|wide]不是图\n[/quote]')).toEqual([]);
  });

  it('无标记/空文本回空表', () => {
    expect(extractMarkupImagePaths('纯文本而已')).toEqual([]);
    expect(extractMarkupImagePaths('')).toEqual([]);
  });
});
