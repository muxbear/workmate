import { describe, it, expect } from '@ohos/hypium'
import { formatNumber, progressPercent, maskPhone } from '../main/ets/common/utils/Formatter'

export default function formatterTest() {
  describe('Formatter', () => {
    it('formatNumber_thousands', 0, () => {
      expect(formatNumber(3262.62)).assertEqual('3,262.62')
    })
    it('formatNumber_small', 0, () => {
      expect(formatNumber(537.38)).assertEqual('537.38')
    })
    it('formatNumber_zero', 0, () => {
      expect(formatNumber(0)).assertEqual('0.00')
    })
    it('progressPercent_normal', 0, () => {
      expect(progressPercent(537.38, 3800)).assertEqual(14.1)
    })
    it('progressPercent_zeroTotal', 0, () => {
      expect(progressPercent(10, 0)).assertEqual(0)
    })
    it('maskPhone_normal', 0, () => {
      expect(maskPhone('15011115831')).assertEqual('150****5831')
    })
    it('maskPhone_short', 0, () => {
      expect(maskPhone('123')).assertEqual('123')
    })
  })
}

