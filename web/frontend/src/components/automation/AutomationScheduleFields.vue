<script setup lang="ts">
/**
 * 「执行频率 + 有效期」表单段（自动化任务弹窗与定时模板弹窗共用）。
 *
 * 直接接收一个 `AutomationSchedule` 对象并**就地修改**它的字段：父组件持有该对象，
 * 两种弹窗本来也是这么用的（`schedule.freqGroup = 'cycle'` 这类写法）。
 * 因此这里只声明 prop，不需要 emit——改动通过对象本身回流到父组件。
 */
import { computed } from 'vue'
import {
  buildFreqSummary,
  buildValiditySummary,
  CYCLE_OPTIONS,
  INTERVAL_OPTIONS,
  WEEK_DAYS,
} from '@/types/automation'
import type { AutomationSchedule } from '@/types/automation'

const props = defineProps<{ schedule: AutomationSchedule }>()

/** 单次任务不需要设置有效期 */
const isOnce = computed(
  () => props.schedule.freqGroup === 'cycle' && props.schedule.cycleKind === 'once',
)

const freqSummary = computed(() => buildFreqSummary(props.schedule))
const validitySummary = computed(() => buildValiditySummary(props.schedule))

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1)
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1)

/** 星期多选：点击切换，至少保留一天 */
function toggleWeekDay(list: number[], value: number): void {
  const index = list.indexOf(value)
  if (index >= 0) {
    if (list.length === 1) return
    list.splice(index, 1)
  } else {
    list.push(value)
  }
}
</script>

<template>
  <div class="atd-field">
    <label class="atd-label">执行频率</label>
    <div class="atd-seg">
      <button
        class="atd-seg-btn"
        :class="{ 'atd-seg-btn--active': schedule.freqGroup === 'cycle' }"
        @click="schedule.freqGroup = 'cycle'"
      >
        周期
      </button>
      <button
        class="atd-seg-btn"
        :class="{ 'atd-seg-btn--active': schedule.freqGroup === 'interval' }"
        @click="schedule.freqGroup = 'interval'"
      >
        间隔
      </button>
    </div>

    <template v-if="schedule.freqGroup === 'cycle'">
      <div class="atd-seg atd-seg--sub">
        <button
          v-for="option in CYCLE_OPTIONS"
          :key="option.key"
          class="atd-seg-btn atd-seg-btn--sm"
          :class="{ 'atd-seg-btn--active': schedule.cycleKind === option.key }"
          @click="schedule.cycleKind = option.key"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="atd-freq-row">
        <template v-if="schedule.cycleKind === 'once'">
          <span class="atd-freq-label">日期</span>
          <input v-model="schedule.onceDate" type="date" class="atd-input atd-input--sm" />
          <span class="atd-freq-label">时间</span>
          <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
        </template>
        <template v-else-if="schedule.cycleKind === 'daily'">
          <span class="atd-freq-label">时间</span>
          <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
        </template>
        <template v-else-if="schedule.cycleKind === 'weekly'">
          <span class="atd-freq-label">星期</span>
          <div class="atd-weekdays">
            <button
              v-for="day in WEEK_DAYS"
              :key="day.value"
              class="atd-weekday"
              :class="{ 'atd-weekday--active': schedule.weekDays.includes(day.value) }"
              @click="toggleWeekDay(schedule.weekDays, day.value)"
            >
              {{ day.label }}
            </button>
          </div>
          <span class="atd-freq-label">时间</span>
          <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
        </template>
        <template v-else-if="schedule.cycleKind === 'monthly'">
          <span class="atd-freq-label">每月</span>
          <select v-model.number="schedule.monthDay" class="atd-input atd-input--sm">
            <option v-for="day in MONTH_DAYS" :key="day" :value="day">{{ day }}</option>
          </select>
          <span class="atd-freq-label">日</span>
          <span class="atd-freq-label">时间</span>
          <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
        </template>
        <template v-else>
          <span class="atd-freq-label">每年</span>
          <select v-model.number="schedule.yearMonth" class="atd-input atd-input--sm">
            <option v-for="month in MONTHS" :key="month" :value="month">{{ month }}</option>
          </select>
          <span class="atd-freq-label">月</span>
          <select v-model.number="schedule.yearDay" class="atd-input atd-input--sm">
            <option v-for="day in MONTH_DAYS" :key="day" :value="day">{{ day }}</option>
          </select>
          <span class="atd-freq-label">日</span>
          <span class="atd-freq-label">时间</span>
          <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
        </template>
      </div>
    </template>

    <template v-else>
      <div class="atd-seg atd-seg--sub">
        <button
          v-for="option in INTERVAL_OPTIONS"
          :key="option.key"
          class="atd-seg-btn atd-seg-btn--sm"
          :class="{ 'atd-seg-btn--active': schedule.intervalKind === option.key }"
          @click="schedule.intervalKind = option.key"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="atd-freq-row">
        <template v-if="schedule.intervalKind === 'weekly'">
          <span class="atd-freq-label">星期</span>
          <div class="atd-weekdays">
            <button
              v-for="day in WEEK_DAYS"
              :key="day.value"
              class="atd-weekday"
              :class="{
                'atd-weekday--active': schedule.weekIntervalDays.includes(day.value),
              }"
              @click="toggleWeekDay(schedule.weekIntervalDays, day.value)"
            >
              {{ day.label }}
            </button>
          </div>
        </template>
        <template v-else>
          <span class="atd-freq-label">每隔</span>
          <input
            v-model.number="schedule.hourInterval"
            type="number"
            min="1"
            max="24"
            class="atd-input atd-input--num"
          />
          <span class="atd-freq-label">小时执行 1 次</span>
        </template>
      </div>
    </template>

    <p class="atd-summary">执行计划：{{ freqSummary }}</p>
  </div>

  <div class="atd-field">
    <label class="atd-label">有效期</label>
    <p v-if="isOnce" class="atd-summary">单次任务仅在指定时间执行一次，无需设置有效期。</p>
    <template v-else>
      <div class="atd-seg">
        <button
          class="atd-seg-btn"
          :class="{ 'atd-seg-btn--active': schedule.validityMode === 'forever' }"
          @click="schedule.validityMode = 'forever'"
        >
          长期有效
        </button>
        <button
          class="atd-seg-btn"
          :class="{ 'atd-seg-btn--active': schedule.validityMode === 'range' }"
          @click="schedule.validityMode = 'range'"
        >
          指定时间段
        </button>
      </div>
      <div v-if="schedule.validityMode === 'range'" class="atd-validity">
        <div class="atd-freq-row">
          <span class="atd-freq-label">开始</span>
          <input v-model="schedule.validFrom" type="date" class="atd-input atd-input--sm" />
          <input v-model="schedule.validFromTime" type="time" class="atd-input atd-input--sm" />
        </div>
        <div class="atd-freq-row">
          <span class="atd-freq-label">结束</span>
          <input v-model="schedule.validTo" type="date" class="atd-input atd-input--sm" />
          <input v-model="schedule.validToTime" type="time" class="atd-input atd-input--sm" />
        </div>
      </div>
      <p class="atd-summary">有效期：{{ validitySummary }}</p>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/assets/styles/automationForm.scss';
</style>
