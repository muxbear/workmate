import { describe, it, expect } from '@ohos/hypium'
import { ServiceFactory } from '../main/ets/services/ServiceFactory'
import { ResultFail } from '../main/ets/common/types/Models'

export default function mockServiceTest() {
  describe('MockServices', () => {
    it('oneClickLogin_returnsProfile', 0, async () => {
      const r = await ServiceFactory.getAuth().oneClickLogin('mock-provider-token')
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.profile.nickname).assertEqual('苜蓿')
        expect(r.value.token.length).assertLarger(0)
      }
    })
    it('oneClickLogin_emptyTokenFails', 0, async () => {
      const r = await ServiceFactory.getAuth().oneClickLogin('')
      expect(r.ok).assertFalse()
    })
    it('login_wrongCodeFails', 0, async () => {
      const r = await ServiceFactory.getAuth().login('15011115831', '000000')
      expect(r.ok).assertFalse()
      if (!r.ok) {
        const fail = r as ResultFail
        expect(fail.code).assertEqual(1001)
      }
    })
    it('login_correctCodeSucceeds', 0, async () => {
      const r = await ServiceFactory.getAuth().login('15011115831', '123456')
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.profile.phone).assertEqual('150****5831')
        expect(r.value.profile.nickname).assertEqual('苜蓿')
        expect(r.value.token.length).assertLarger(0)
      }
    })
    it('listWorkspaces_matchesDesign', 0, async () => {
      const r = await ServiceFactory.getTask().listWorkspaces()
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.length).assertEqual(3)
        expect(r.value[0].name).assertEqual('任务')
        expect(r.value[0].device).assertEqual('DESKTOP-S3R6IMC')
        expect(r.value[2].name).assertEqual('我的工作空间')
      }
    })
    it('getPoints_matchesDesign', 0, async () => {
      const r = await ServiceFactory.getUser().getPoints()
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.balance).assertEqual(3262.62)
        expect(r.value.gifted.used).assertEqual(537.38)
      }
    })
    it('chat_cloudReturnsTable', 0, async () => {
      const r = await ServiceFactory.getChat().send({ mode: 'cloud', message: '测试', history: [] })
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.reply.some(b => b.type === 'table')).assertTrue()
      }
    })
    it('chat_desktopReturnsList', 0, async () => {
      const r = await ServiceFactory.getChat().send({ mode: 'desktop', message: '测试', history: [] })
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.reply.some(b => b.type === 'list')).assertTrue()
      }
    })
    it('tasks_emptyList', 0, async () => {
      const r = await ServiceFactory.getTask().listTasks()
      expect(r.ok).assertTrue()
      if (r.ok) {
        expect(r.value.length).assertEqual(0)
      }
    })
  })
}
