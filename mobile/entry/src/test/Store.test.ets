import { describe, it, expect } from '@ohos/hypium'
import { sessionStore } from '../main/ets/store/SessionStore'
import { chatStore } from '../main/ets/store/ChatStore'
import { settingsStore } from '../main/ets/store/SettingsStore'

export default function storeTest() {
  describe('Stores', () => {
    it('session_loginSetsState', 0, () => {
      sessionStore.login({ token: 't1', profile: { nickname: '苜蓿', phone: '150****5831', level: '体验版', avatarColor: '#34d399' } })
      expect(sessionStore.isLoggedIn).assertTrue()
      expect(sessionStore.profile?.nickname).assertEqual('苜蓿')
      expect(sessionStore.token).assertEqual('t1')
    })
    it('session_logoutClearsState', 0, () => {
      sessionStore.logout()
      expect(sessionStore.isLoggedIn).assertFalse()
      expect(sessionStore.profile).assertNull()
      expect(sessionStore.points).assertNull()
    })
    it('chat_sendAppendsThinkingThenDone', 0, async () => {
      chatStore.reset()
      await chatStore.send('帮我查一下')
      expect(chatStore.messages.length).assertEqual(2)
      expect(chatStore.messages[0].role).assertEqual('user')
      expect(chatStore.messages[1].role).assertEqual('assistant')
      expect(chatStore.messages[1].status).assertEqual('done')
      expect(chatStore.sending).assertFalse()
    })
    it('chat_modeSwitch', 0, () => {
      chatStore.mode = 'desktop'
      expect(chatStore.mode).assertEqual('desktop')
      chatStore.mode = 'cloud'
    })
    it('settings_themeSwitch', 0, () => {
      settingsStore.setTheme('dark')
      expect(settingsStore.theme).assertEqual('dark')
      settingsStore.setTheme('system')
    })
  })
}
