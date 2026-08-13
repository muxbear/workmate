/** 数字千分位格式化,保留 2 位小数:3262.62 -> "3,262.62" */
export function formatNumber(n: number): string {
  const fixed = n.toFixed(2)
  const parts = fixed.split('.')
  const intPart = parts[0]
  const fracPart = parts[1]
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${grouped}.${fracPart}`
}

/** 计算积分进度百分比(0~100,四舍五入一位):used 537.38 / total 3800 -> 14.1 */
export function progressPercent(used: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return Math.round((used / total) * 1000) / 10
}

/** 手机号脱敏:15011115831 -> "150****5831" */
export function maskPhone(phone: string): string {
  if (phone.length < 7) {
    return phone
  }
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}
