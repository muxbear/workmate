import { describe, it, expect } from '@ohos/hypium'
import { toResult, ResultFail } from '../main/ets/common/types/Models'

export default function modelsTest() {
  describe('Models', () => {
    it('toResult_success', 0, () => {
      const r = toResult<number>({ code: 0, message: 'ok', data: 42 })
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value).assertEqual(42)
      }
    })
    it('toResult_businessError', 0, () => {
      const r = toResult<number>({ code: 1001, message: '验证码错误', data: null })
      expect(r.ok).assertFalse()
      if (!r.ok) {
        const fail = r as ResultFail
        expect(fail.code).assertEqual(1001)
      }
    })
    it('toResult_nullDataIsError', 0, () => {
      const r = toResult<number>({ code: 0, message: 'ok', data: null })
      expect(r.ok).assertFalse()
    })
  })
}
