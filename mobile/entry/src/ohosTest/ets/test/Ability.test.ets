import { hilog } from '@kit.PerformanceAnalysisKit';
import { describe, beforeAll, beforeEach, afterEach, afterAll, it, expect } from '@ohos/hypium';
import { driver } from '@kit.TestKit'

export default function abilityTest() {
  describe('ActsAbilityTest', () => {
    // Defines a test suite. Two parameters are supported: test suite name and test suite function.
    beforeAll(() => {
      // Presets an action, which is performed only once before all test cases of the test suite start.
      // This API supports only one parameter: preset action function.
    })
    beforeEach(() => {
      // Presets an action, which is performed before each unit test case starts.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: preset action function.
    })
    afterEach(() => {
      // Presets a clear action, which is performed after each unit test case ends.
      // The number of execution times is the same as the number of test cases defined by **it**.
      // This API supports only one parameter: clear action function.
    })
    afterAll(() => {
      // Presets a clear action, which is performed after all test cases of the test suite end.
      // This API supports only one parameter: clear action function.
    })
    it('assertContain', 0, () => {
      // Defines a test case. This API supports three parameters: test case name, filter parameter, and test case function.
      hilog.info(0x0000, 'testTag', '%{public}s', 'it begin');
      let a = 'abc';
      let b = 'b';
      // Defines a variety of assertion methods, which are used to declare expected boolean conditions.
      expect(a).assertContain(b);
      expect(a).assertEqual(a);
    })
  })

  // UI 冒烟测试:欢迎页 -> 登录页 -> 一键登录 -> 首页(需 DevEco Studio 模拟器/真机执行)
  describe('SmokeTest', () => {
    it('welcome_login_home_flow', 0, async () => {
      const d = driver.createDriver()
      // 欢迎页出现 -> 跳过
      await d.delayMs(500)
      const skip = await d.findComponent(d.getKey(Text).id('welcome_skip'))
      if (skip != null) {
        await skip.click()
      }
      await d.delayMs(600)
      // 登录页 -> 勾选协议 -> 手机号登录 -> 一键登录
      const agree = await d.findComponent(d.getKey(Text).id('login_agree_check'))
      if (agree != null) {
        await agree.click()
      }
      const loginBtn = await d.findComponent(d.getKey(Text).id('login_phone'))
      if (loginBtn != null) {
        await loginBtn.click()
      }
      await d.delayMs(1000)
      const oneClick = await d.findComponent(d.getKey(Text).id('oneclick_button'))
      if (oneClick != null) {
        await oneClick.click()
      }
      await d.delayMs(2000)
      // 首页断言:主标题
      const title = await d.findComponent(d.getKey(Text).id('home_title'))
      expect(title != null).assertTrue()
    })
  })
}