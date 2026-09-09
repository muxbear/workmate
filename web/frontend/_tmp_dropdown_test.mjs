import { chromium } from 'playwright'

const BASE = 'http://localhost:5172'
const q = String.fromCharCode(34)

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' }).catch(() => chromium.launch({ headless: true }))
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
  await page.fill('input[placeholder=' + q + '请输入账号' + q + ']', 'param_test_admin')
  await page.fill('input[placeholder=' + q + '请输入密码' + q + ']', 'Test2026')
  await page.locator('.login-btn').click()
  await page.waitForTimeout(5000)
  console.log('AFTER_URL ', page.url())
  console.log('AFTER_BODY ', (await page.locator('body').innerText()).slice(-800))
  await page.waitForURL('**/overview', { timeout: 30000 })

  await page.goto(BASE + '/admin/params', { waitUntil: 'networkidle' })
  await page.locator('.param-page').waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: '新增分组' }).first().click()

  const dialog = page.locator('.el-dialog').filter({ hasText: '新增父级参数' })
  await dialog.waitFor({ timeout: 10000 })
  const select = dialog.locator('select.form-input')
  const enabled = await select.isEnabled()
  if (!enabled) throw new Error('type select is disabled')
  const options = await select.locator('option').allInnerTexts()
  console.log('TYPE_OPTIONS', JSON.stringify(options))

  await select.selectOption('number')
  const selected = await select.inputValue()
  if (selected !== 'number') throw new Error('select value not changed: ' + selected)

  await dialog.locator('input[placeholder=' + q + '例如 mail.host' + q + ']').fill('fix_verify_group')
  await dialog.locator('input[placeholder=' + q + '用于界面展示的短标签' + q + ']').fill('下拉修复验证')
  await dialog.locator('input[placeholder=' + q + '参数名称或说明标题' + q + ']').fill('验证参数类型可选择')
  await dialog.locator('.btn-primary').click()
  await page.waitForTimeout(2500)
  if (await dialog.isVisible()) {
    console.log('DIALOG_TEXT ', await dialog.innerText())
    console.log('MESSAGES ', JSON.stringify(await page.locator('.el-message').allInnerTexts()))
  }
  await dialog.waitFor({ state: 'detached', timeout: 10000 })
  await page.locator('.tree-row', { hasText: '下拉修复验证' }).waitFor({ timeout: 10000 })
  console.log('DROPDOWN_FIX_OK')
  await browser.close()
}

main().catch((err) => {
  console.error('DROPDOWN_FIX_FAIL', err && err.message ? err.message : err)
  process.exit(1)
})
