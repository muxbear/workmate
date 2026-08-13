import { sessionStore } from '../store/SessionStore'
import { WelcomePage } from './WelcomePage'
import { LoginPage } from './LoginPage'
import { OneClickLoginPage } from './OneClickLoginPage'
import { HomePage } from './HomePage'
import { ChatPage, ChatPageParams } from './ChatPage'
import { SettingsPage } from './SettingsPage'
import { AccountSettingsPage } from './AccountSettingsPage'

/** 导航根:路由注册 + 欢迎页遮罩 */
@Entry
@Component
struct Index {
  pathStack: NavPathStack = new NavPathStack()
  @State showWelcome: boolean = true

  @Builder
  pageMap(name: string, param: object) {
    if (name === 'login') {
      LoginPage({ pathStack: this.pathStack })
    } else if (name === 'oneClickLogin') {
      OneClickLoginPage({ pathStack: this.pathStack })
    } else if (name === 'home') {
      HomePage({ pathStack: this.pathStack })
    } else if (name === 'chat') {
      ChatPage({ pathStack: this.pathStack, params: param as ChatPageParams })
    } else if (name === 'settings') {
      SettingsPage({ pathStack: this.pathStack })
    } else if (name === 'accountSettings') {
      AccountSettingsPage({ pathStack: this.pathStack })
    }
  }

  /** 欢迎页结束后的登录态分流 */
  afterWelcome(): void {
    if (sessionStore.isLoggedIn) {
      this.pathStack.pushPathByName('home', null)
    } else {
      this.pathStack.pushPathByName('login', null)
    }
  }

  build() {
    Stack() {
      Navigation(this.pathStack) {
        Column().width('100%').height('100%')
      }
      .mode(NavigationMode.Stack)
      .hideTitleBar(true)
      .width('100%')
      .height('100%')
      .navDestination(this.pageMap)

      if (this.showWelcome) {
        WelcomePage({
          onDone: () => {
            this.showWelcome = false
            this.afterWelcome()
          },
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg'))
  }
}
