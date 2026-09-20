import test from 'node:test';
import assert from 'node:assert/strict';
import { createErrorDeduper } from '../src/error-deduper.js';

test('same error is notified once during the deduplication window', () => {
  let time = 0;
  const deduper = createErrorDeduper({ windowMs: 1_000, now: () => time });
  assert.equal(deduper.shouldNotify('招待パネルの初期設定', new Error('20 秒以内に完了しませんでした')).notify, true);
  time = 100;
  assert.equal(deduper.shouldNotify('招待パネルの初期設定', new Error('20 秒以内に完了しませんでした')).notify, false);
  time = 1_101;
  assert.equal(deduper.shouldNotify('招待パネルの初期設定', new Error('20 秒以内に完了しませんでした')).notify, true);
});
