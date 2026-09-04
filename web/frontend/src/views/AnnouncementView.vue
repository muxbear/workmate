<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Megaphone,
  RefreshCw,
  Plus,
  Search,
  Eye,
  Edit3,
  Trash2,
  Send,
  BellRing,
} from 'lucide-vue-next'
import type { AnnouncementItem, AnnouncementStatus } from '@/types/announcement'
import type { Department, SystemUser } from '@/types/admin'
import {
  fetchAdminAnnouncements,
  createAdminAnnouncement,
  updateAdminAnnouncement,
  publishAdminAnnouncement,
  deleteAdminAnnouncement,
} from '@/services/announcementApi'
import type { AdminNotificationItem, NotificationLevel } from '@/types/notification'
import { NOTIFICATION_TYPE_LABELS } from '@/types/notification'
import { fetchDepartments, fetchUsers } from '@/services/adminApi'
import {
  fetchAdminNotifications,
  updateAdminNotification,
  deleteAdminNotification,
  sendAdminNotification,
} from '@/services/notificationApi'

/* ---- 常量与类型 ---- */
const LEVEL_META: Record<NotificationLevel, { label: string; color: string; bg: string }> = {
  info: { label: '信息', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.14)' },
  success: { label: '成功', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
  warning: { label: '警告', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.14)' },
  error: { label: '错误', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)' },
}

const STATUS_META: Record<AnnouncementStatus, { label: string; color: string; bg: string }> = {
  draft: { label: '草稿', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.14)' },
  published: { label: '已发布', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
}

interface AnnouncementForm {
  title: string
  content: string
  level: NotificationLevel
  link: string
  status: AnnouncementStatus
}

const emptyAnnouncementForm = (): AnnouncementForm => ({
  title: '',
  content: '',
  level: 'info',
  link: '',
  status: 'draft',
})

/* ---- 状态 ---- */
const activeTab = ref<'announcements' | 'notifications'>('announcements')

// 公告列表
const annLoading = ref(false)
const annItems = ref<AnnouncementItem[]>([])
const annTotal = ref(0)
const annPage = ref(1)
const annPageSize = ref(10)
const annQuery = reactive({
  keyword: '',
  status: '' as AnnouncementStatus | '',
  level: '' as NotificationLevel | '',
})

// 通知列表
const notifLoading = ref(false)
const notifItems = ref<AdminNotificationItem[]>([])
const notifTotal = ref(0)
const notifPage = ref(1)
const notifPageSize = ref(10)
const notifQuery = reactive({
  keyword: '',
  type: '',
  level: '' as NotificationLevel | '',
  isRead: '' as '' | 'true' | 'false',
})

// 公告编辑/发布
const annDialogVisible = ref(false)
const annEditingId = ref<string | null>(null)
const annForm = ref<AnnouncementForm>(emptyAnnouncementForm())
const annSaving = ref(false)

// 公告/通知查看
const annDetail = ref<AnnouncementItem | null>(null)
const notifDetail = ref<AdminNotificationItem | null>(null)
const annDetailVisible = ref(false)
const notifDetailVisible = ref(false)

// 通知编辑
const notifEditVisible = ref(false)
const notifEditing = ref<AdminNotificationItem | null>(null)
const notifSaving = ref(false)
const notifForm = reactive({
  title: '',
  content: '',
  level: 'info' as NotificationLevel,
  link: '',
  is_read: false,
})

// 定向发送通知（个人/组织）
const sendVisible = ref(false)
const sendSaving = ref(false)
const sendMode = ref<'user' | 'department'>('user')
const userOptions = ref<SystemUser[]>([])
const deptTree = ref<Department[]>([])
const deptCheckedKeys = ref<string[]>([])
const sendForm = reactive({
  title: '',
  content: '',
  level: 'info' as NotificationLevel,
  link: '',
  userIds: [] as string[],
})

/* ---- 数据加载 ---- */
async function loadAnnouncements(page = annPage.value) {
  annLoading.value = true
  try {
    const res = await fetchAdminAnnouncements({
      page,
      page_size: annPageSize.value,
      keyword: annQuery.keyword.trim() || undefined,
      status: annQuery.status || undefined,
      level: annQuery.level || undefined,
    })
    annItems.value = res.items
    annTotal.value = res.total
    annPage.value = res.page
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '公告加载失败')
  } finally {
    annLoading.value = false
  }
}

async function loadNotifications(page = notifPage.value) {
  notifLoading.value = true
  try {
    const res = await fetchAdminNotifications({
      page,
      page_size: notifPageSize.value,
      keyword: notifQuery.keyword.trim() || undefined,
      type: notifQuery.type || undefined,
      level: notifQuery.level || undefined,
      is_read: notifQuery.isRead === '' ? undefined : notifQuery.isRead === 'true',
    })
    notifItems.value = res.items
    notifTotal.value = res.total
    notifPage.value = res.page
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '通知加载失败')
  } finally {
    notifLoading.value = false
  }
}

/* ---- 公告操作 ---- */
function openCreateAnnouncement() {
  annEditingId.value = null
  annForm.value = emptyAnnouncementForm()
  annDialogVisible.value = true
}

function openEditAnnouncement(item: AnnouncementItem) {
  annEditingId.value = item.id
  annForm.value = {
    title: item.title,
    content: item.content,
    level: item.level,
    link: item.link ?? '',
    status: item.status,
  }
  annDialogVisible.value = true
}

async function submitAnnouncement(publishNow: boolean) {
  if (!annForm.value.title.trim()) {
    ElMessage.warning('请输入公告标题')
    return
  }
  const editingId = annEditingId.value
  const payload = {
    title: annForm.value.title.trim(),
    content: annForm.value.content,
    level: annForm.value.level,
    link: annForm.value.link.trim() || null,
    status: annForm.value.status,
  }
  const existing = editingId ? annItems.value.find((a) => a.id === editingId) : null
  if (existing && existing.status === 'published' && !publishNow) {
    payload.status = 'published'
  } else {
    payload.status = publishNow ? 'published' : 'draft'
  }
  annSaving.value = true
  try {
    if (editingId) {
      await updateAdminAnnouncement(editingId, payload)
      ElMessage.success(existing?.status === 'published' ? '公告已更新' : '草稿已更新')
    } else {
      await createAdminAnnouncement(payload)
      ElMessage.success(publishNow ? '公告已发布' : '草稿已保存')
    }
    annDialogVisible.value = false
    await loadAnnouncements()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    annSaving.value = false
  }
}

async function handlePublish(item: AnnouncementItem) {
  try {
    await ElMessageBox.confirm(
      `确认发布公告「${item.title}」？发布后所有用户可在通知面板看到。`,
      '发布公告',
      {
        confirmButtonText: '发布',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  try {
    await publishAdminAnnouncement(item.id)
    ElMessage.success('公告已发布')
    await loadAnnouncements()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '发布失败')
  }
}

async function handleDeleteAnnouncement(item: AnnouncementItem) {
  try {
    await ElMessageBox.confirm(
      `确定删除公告「${item.title}」？删除后用户将无法再查看。`,
      '确认删除',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  try {
    await deleteAdminAnnouncement(item.id)
    ElMessage.success('公告已删除')
    if (annItems.value.length === 1 && annPage.value > 1) {
      annPage.value -= 1
    }
    await loadAnnouncements()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/* ---- 通知操作 ---- */
function openEditNotification(item: AdminNotificationItem) {
  notifEditing.value = item
  notifForm.title = item.title
  notifForm.content = item.content
  notifForm.level = item.level
  notifForm.link = item.link ?? ''
  notifForm.is_read = item.is_read
  notifEditVisible.value = true
}

async function submitNotification() {
  if (!notifEditing.value) return
  if (!notifForm.title.trim()) {
    ElMessage.warning('请输入通知标题')
    return
  }
  notifSaving.value = true
  try {
    await updateAdminNotification(notifEditing.value.id, {
      title: notifForm.title.trim(),
      content: notifForm.content,
      level: notifForm.level,
      link: notifForm.link.trim() || null,
      is_read: notifForm.is_read,
    })
    ElMessage.success('通知已更新')
    notifEditVisible.value = false
    await loadNotifications()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    notifSaving.value = false
  }
}

async function openSendNotification() {
  sendMode.value = 'user'
  sendForm.title = ''
  sendForm.content = ''
  sendForm.level = 'info'
  sendForm.link = ''
  sendForm.userIds = []
  deptCheckedKeys.value = []
  sendVisible.value = true
  if (userOptions.value.length === 0 || deptTree.value.length === 0) {
    try {
      const [users, depts] = await Promise.all([fetchUsers(), fetchDepartments()])
      userOptions.value = users.filter((u) => u.accountId)
      deptTree.value = depts
    } catch (err: unknown) {
      ElMessage.error(err instanceof Error ? err.message : '接收人数据加载失败')
    }
  }
}

function onDeptCheck(_data: unknown, status: { checkedKeys: unknown[] }) {
  deptCheckedKeys.value = status.checkedKeys
    .filter((key): key is string => typeof key === 'string')
    .slice()
}

async function submitSendNotification() {
  if (!sendForm.title.trim()) {
    ElMessage.warning('请输入通知标题')
    return
  }
  const departmentIds = sendMode.value === 'department' ? deptCheckedKeys.value : []
  const userIds = sendMode.value === 'user' ? sendForm.userIds : []
  if (userIds.length === 0 && departmentIds.length === 0) {
    ElMessage.warning('请至少选择一位接收用户或一个接收组织')
    return
  }
  sendSaving.value = true
  try {
    const res = await sendAdminNotification({
      title: sendForm.title.trim(),
      content: sendForm.content,
      level: sendForm.level,
      link: sendForm.link.trim() || null,
      user_ids: userIds,
      department_ids: departmentIds,
    })
    if (res.sent === 0) {
      ElMessage.warning('所选接收范围内没有已绑定账号的成员，未发送')
    } else {
      ElMessage.success(`通知已发送给 ${res.sent} 位用户`)
    }
    sendVisible.value = false
    await loadNotifications()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '发送失败')
  } finally {
    sendSaving.value = false
  }
}

async function handleDeleteNotification(item: AdminNotificationItem) {
  try {
    await ElMessageBox.confirm(`确定删除通知「${item.title}」？`, '确认删除', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await deleteAdminNotification(item.id)
    ElMessage.success('通知已删除')
    if (notifItems.value.length === 1 && notifPage.value > 1) {
      notifPage.value -= 1
    }
    await loadNotifications()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/* ---- 查看详情辅助 ---- */
function openViewAnnouncement(item: AnnouncementItem) {
  annDetail.value = item
  annDetailVisible.value = true
}

function closeAnnouncementDetail() {
  annDetail.value = null
  annDetailVisible.value = false
}

function editFromAnnouncementDetail() {
  if (annDetail.value) {
    openEditAnnouncement(annDetail.value)
    closeAnnouncementDetail()
  }
}

function openViewNotification(item: AdminNotificationItem) {
  notifDetail.value = item
  notifDetailVisible.value = true
}

function closeNotificationDetail() {
  notifDetail.value = null
  notifDetailVisible.value = false
}

function editFromNotificationDetail() {
  if (notifDetail.value) {
    openEditNotification(notifDetail.value)
    closeNotificationDetail()
  }
}

/* ---- 展示辅助 ---- */
function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function displayUser(item: AdminNotificationItem): string {
  const u = item.user
  if (!u) return '—'
  return u.nickname || u.username || u.id.slice(0, 8)
}

function resetAnnQuery() {
  annQuery.keyword = ''
  annQuery.status = ''
  annQuery.level = ''
  loadAnnouncements(1)
}

function resetNotifQuery() {
  notifQuery.keyword = ''
  notifQuery.type = ''
  notifQuery.level = ''
  notifQuery.isRead = ''
  loadNotifications(1)
}

watch(activeTab, (tab) => {
  if (tab === 'announcements') {
    loadAnnouncements()
  } else {
    loadNotifications()
  }
})

onMounted(() => {
  loadAnnouncements()
})
</script>

<template>
  <div class="announcement-page">
    <!-- ═══ 页头 ═══ -->
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">公告管理</h1>
        <p class="page-subtitle">统一管理右上角通知面板中的公告与通知</p>
      </div>
      <div class="header-right">
        <button
          class="btn-secondary"
          @click="activeTab === 'announcements' ? loadAnnouncements() : loadNotifications()"
        >
          <RefreshCw :size="14" />
          刷新
        </button>
        <button
          v-if="activeTab === 'notifications'"
          class="btn-secondary"
          @click="openSendNotification"
        >
          <BellRing :size="14" />
          发送通知
        </button>
        <button class="btn-primary" @click="openCreateAnnouncement">
          <Plus :size="16" />
          发布公告
        </button>
      </div>
    </div>

    <!-- ═══ 内容区 ═══ -->
    <div class="content-card">
      <el-tabs v-model="activeTab" class="manage-tabs">
        <el-tab-pane label="公告管理" name="announcements">
          <!-- 工具栏 -->
          <div class="toolbar">
            <div class="search-wrap">
              <Search :size="14" class="search-icon" />
              <input
                v-model="annQuery.keyword"
                type="text"
                placeholder="搜索公告标题、内容…"
                class="search-input"
                @keyup.enter="loadAnnouncements(1)"
              />
            </div>
            <el-select v-model="annQuery.status" placeholder="状态" clearable style="width: 120px">
              <el-option label="草稿" value="draft" />
              <el-option label="已发布" value="published" />
            </el-select>
            <el-select v-model="annQuery.level" placeholder="级别" clearable style="width: 120px">
              <el-option
                v-for="(meta, key) in LEVEL_META"
                :key="key"
                :label="meta.label"
                :value="key"
              />
            </el-select>
            <button class="btn-ghost" @click="loadAnnouncements(1)">查询</button>
            <button class="btn-ghost" @click="resetAnnQuery">重置</button>
            <span class="toolbar-count">共 {{ annTotal }} 条</span>
          </div>

          <el-table
            v-loading="annLoading"
            :data="annItems"
            class="manage-table"
            empty-text="暂无公告"
          >
            <el-table-column label="标题" min-width="220">
              <template #default="{ row }">
                <div class="title-cell">
                  <Megaphone :size="14" class="title-icon" />
                  <span class="title-text">{{ row.title }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="内容" min-width="240" show-overflow-tooltip>
              <template #default="{ row }: { row: AnnouncementItem }">
                <span class="content-preview">{{ row.content || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="级别" width="90">
              <template #default="{ row }: { row: AnnouncementItem }">
                <span
                  class="level-tag"
                  :style="{
                    color: LEVEL_META[row.level].color,
                    background: LEVEL_META[row.level].bg,
                  }"
                >
                  {{ LEVEL_META[row.level].label }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }: { row: AnnouncementItem }">
                <span
                  class="level-tag"
                  :style="{
                    color: STATUS_META[row.status].color,
                    background: STATUS_META[row.status].bg,
                  }"
                >
                  {{ STATUS_META[row.status].label }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="发布时间" width="170">
              <template #default="{ row }: { row: AnnouncementItem }">
                <span class="muted-text">{{ formatTime(row.published_at) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="已读" width="80" align="center">
              <template #default="{ row }: { row: AnnouncementItem }">
                <span class="muted-text">{{ row.read_count }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{ row }: { row: AnnouncementItem }">
                <div class="ops">
                  <button class="op-btn" title="查看" @click="openViewAnnouncement(row)">
                    <Eye :size="14" />
                  </button>
                  <button class="op-btn" title="编辑" @click="openEditAnnouncement(row)">
                    <Edit3 :size="14" />
                  </button>
                  <button
                    v-if="row.status === 'draft'"
                    class="op-btn op-btn--publish"
                    title="发布"
                    @click="handlePublish(row)"
                  >
                    <Send :size="14" />
                  </button>
                  <button
                    class="op-btn op-btn--danger"
                    title="删除"
                    @click="handleDeleteAnnouncement(row)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div class="pagination-row">
            <el-pagination
              v-model:current-page="annPage"
              v-model:page-size="annPageSize"
              :total="annTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              background
              @current-change="loadAnnouncements"
              @size-change="loadAnnouncements(1)"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="通知管理" name="notifications">
          <!-- 工具栏 -->
          <div class="toolbar">
            <div class="search-wrap">
              <Search :size="14" class="search-icon" />
              <input
                v-model="notifQuery.keyword"
                type="text"
                placeholder="搜索标题、内容或用户…"
                class="search-input"
                @keyup.enter="loadNotifications(1)"
              />
            </div>
            <el-select
              v-model="notifQuery.type"
              placeholder="类型"
              clearable
              filterable
              style="width: 150px"
            >
              <el-option
                v-for="(label, key) in NOTIFICATION_TYPE_LABELS"
                :key="key"
                :label="label"
                :value="key"
              />
            </el-select>
            <el-select v-model="notifQuery.level" placeholder="级别" clearable style="width: 110px">
              <el-option
                v-for="(meta, key) in LEVEL_META"
                :key="key"
                :label="meta.label"
                :value="key"
              />
            </el-select>
            <el-select
              v-model="notifQuery.isRead"
              placeholder="已读状态"
              clearable
              style="width: 120px"
            >
              <el-option label="已读" value="true" />
              <el-option label="未读" value="false" />
            </el-select>
            <button class="btn-ghost" @click="loadNotifications(1)">查询</button>
            <button class="btn-ghost" @click="resetNotifQuery">重置</button>
            <span class="toolbar-count">共 {{ notifTotal }} 条</span>
          </div>

          <el-table
            v-loading="notifLoading"
            :data="notifItems"
            class="manage-table"
            empty-text="暂无通知"
          >
            <el-table-column label="标题" min-width="200" show-overflow-tooltip prop="title" />
            <el-table-column label="内容" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="content-preview">{{ row.content || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="用户" width="140" show-overflow-tooltip>
              <template #default="{ row }: { row: AdminNotificationItem }">
                <span class="user-cell">
                  <BellRing :size="13" class="user-icon" />
                  {{ displayUser(row) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="级别" width="90">
              <template #default="{ row }: { row: AdminNotificationItem }">
                <span
                  class="level-tag"
                  :style="{
                    color: LEVEL_META[row.level].color,
                    background: LEVEL_META[row.level].bg,
                  }"
                >
                  {{ LEVEL_META[row.level].label }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="130" show-overflow-tooltip>
              <template #default="{ row }: { row: AdminNotificationItem }">
                {{ NOTIFICATION_TYPE_LABELS[row.type] || row.type }}
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }: { row: AdminNotificationItem }">
                <span class="read-tag" :class="{ unread: !row.is_read }">{{
                  row.is_read ? '已读' : '未读'
                }}</span>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="170">
              <template #default="{ row }: { row: AdminNotificationItem }">
                <span class="muted-text">{{ formatTime(row.created_at) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }: { row: AdminNotificationItem }">
                <div class="ops">
                  <button class="op-btn" title="查看" @click="openViewNotification(row)">
                    <Eye :size="14" />
                  </button>
                  <button class="op-btn" title="编辑" @click="openEditNotification(row)">
                    <Edit3 :size="14" />
                  </button>
                  <button
                    class="op-btn op-btn--danger"
                    title="删除"
                    @click="handleDeleteNotification(row)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div class="pagination-row">
            <el-pagination
              v-model:current-page="notifPage"
              v-model:page-size="notifPageSize"
              :total="notifTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              background
              @current-change="loadNotifications"
              @size-change="loadNotifications(1)"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- ═══ 公告编辑/发布弹窗 ═══ -->
    <el-dialog
      v-model="annDialogVisible"
      :title="annEditingId ? '编辑公告' : '发布公告'"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form label-width="70px">
        <el-form-item label="标题" required>
          <el-input
            v-model="annForm.title"
            maxlength="200"
            show-word-limit
            placeholder="请输入公告标题"
          />
        </el-form-item>
        <el-form-item label="级别">
          <el-select v-model="annForm.level" style="width: 160px">
            <el-option
              v-for="(meta, key) in LEVEL_META"
              :key="key"
              :label="meta.label"
              :value="key"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="链接">
          <el-input
            v-model="annForm.link"
            maxlength="512"
            placeholder="点击后跳转的地址（可选），如 /knowledge-base"
          />
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="annForm.content"
            type="textarea"
            :rows="8"
            placeholder="请输入公告内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="annDialogVisible = false">取消</el-button>
        <el-button
          v-if="annForm.status !== 'published'"
          :loading="annSaving"
          @click="submitAnnouncement(false)"
        >
          保存草稿
        </el-button>
        <el-button type="primary" :loading="annSaving" @click="submitAnnouncement(true)">
          {{ annEditingId && annForm.status === 'published' ? '保存修改' : '立即发布' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ═══ 公告查看弹窗 ═══ -->
    <el-dialog v-model="annDetailVisible" title="公告详情" width="640px">
      <template v-if="annDetail">
        <div class="detail-head">
          <h3 class="detail-title">{{ annDetail.title }}</h3>
          <div class="detail-meta">
            <span
              class="level-tag"
              :style="{
                color: STATUS_META[annDetail.status].color,
                background: STATUS_META[annDetail.status].bg,
              }"
            >
              {{ STATUS_META[annDetail.status].label }}
            </span>
            <span
              class="level-tag"
              :style="{
                color: LEVEL_META[annDetail.level].color,
                background: LEVEL_META[annDetail.level].bg,
              }"
            >
              {{ LEVEL_META[annDetail.level].label }}
            </span>
          </div>
        </div>
        <el-descriptions :column="2" border class="detail-desc">
          <el-descriptions-item label="发布时间">{{
            formatTime(annDetail.published_at)
          }}</el-descriptions-item>
          <el-descriptions-item label="已读人数">{{ annDetail.read_count }}</el-descriptions-item>
          <el-descriptions-item label="创建时间" :span="2">{{
            formatTime(annDetail.created_at)
          }}</el-descriptions-item>
          <el-descriptions-item v-if="annDetail.link" label="跳转链接" :span="2">
            <a :href="annDetail.link" target="_blank" rel="noopener" class="detail-link">{{
              annDetail.link
            }}</a>
          </el-descriptions-item>
        </el-descriptions>
        <div class="detail-content">
          <p class="detail-section-label">公告内容</p>
          <div class="detail-body">{{ annDetail.content || '（无内容）' }}</div>
        </div>
      </template>
      <template #footer>
        <el-button @click="closeAnnouncementDetail()">关闭</el-button>
        <el-button type="primary" @click="editFromAnnouncementDetail()">编辑</el-button>
      </template>
    </el-dialog>

    <!-- ═══ 通知编辑弹窗 ═══ -->
    <el-dialog
      v-model="notifEditVisible"
      title="编辑通知"
      width="600px"
      :close-on-click-modal="false"
    >
      <el-form label-width="70px">
        <el-form-item label="标题" required>
          <el-input
            v-model="notifForm.title"
            maxlength="128"
            show-word-limit
            placeholder="请输入通知标题"
          />
        </el-form-item>
        <el-form-item label="级别">
          <el-select v-model="notifForm.level" style="width: 160px">
            <el-option
              v-for="(meta, key) in LEVEL_META"
              :key="key"
              :label="meta.label"
              :value="key"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="链接">
          <el-input
            v-model="notifForm.link"
            maxlength="512"
            placeholder="点击后跳转的地址（可选）"
          />
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="notifForm.content"
            type="textarea"
            :rows="6"
            placeholder="请输入通知内容"
          />
        </el-form-item>
        <el-form-item label="已读">
          <el-switch v-model="notifForm.is_read" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="notifEditVisible = false">取消</el-button>
        <el-button type="primary" :loading="notifSaving" @click="submitNotification"
          >保存</el-button
        >
      </template>
    </el-dialog>

    <!-- ═══ 通知查看弹窗 ═══ -->
    <el-dialog v-model="notifDetailVisible" title="通知详情" width="600px">
      <template v-if="notifDetail">
        <div class="detail-head">
          <h3 class="detail-title">{{ notifDetail.title }}</h3>
          <div class="detail-meta">
            <span
              class="level-tag"
              :style="{
                color: LEVEL_META[notifDetail.level].color,
                background: LEVEL_META[notifDetail.level].bg,
              }"
            >
              {{ LEVEL_META[notifDetail.level].label }}
            </span>
            <span class="read-tag" :class="{ unread: !notifDetail.is_read }">{{
              notifDetail.is_read ? '已读' : '未读'
            }}</span>
          </div>
        </div>
        <el-descriptions :column="2" border class="detail-desc">
          <el-descriptions-item label="接收用户">{{
            displayUser(notifDetail)
          }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{
            NOTIFICATION_TYPE_LABELS[notifDetail.type] || notifDetail.type
          }}</el-descriptions-item>
          <el-descriptions-item label="创建时间" :span="2">{{
            formatTime(notifDetail.created_at)
          }}</el-descriptions-item>
          <el-descriptions-item v-if="notifDetail.read_at" label="已读时间" :span="2">{{
            formatTime(notifDetail.read_at)
          }}</el-descriptions-item>
          <el-descriptions-item v-if="notifDetail.link" label="跳转链接" :span="2">
            <a :href="notifDetail.link" target="_blank" rel="noopener" class="detail-link">{{
              notifDetail.link
            }}</a>
          </el-descriptions-item>
        </el-descriptions>
        <div class="detail-content">
          <p class="detail-section-label">通知内容</p>
          <div class="detail-body">{{ notifDetail.content || '（无内容）' }}</div>
        </div>
      </template>
      <template #footer>
        <el-button @click="closeNotificationDetail()">关闭</el-button>
        <el-button type="primary" @click="editFromNotificationDetail()">编辑</el-button>
      </template>
    </el-dialog>

    <!-- 发送通知（个人/组织） -->
    <el-dialog v-model="sendVisible" title="发送通知" width="680px" :close-on-click-modal="false">
      <el-form label-width="80px">
        <el-form-item label="接收对象">
          <el-radio-group v-model="sendMode">
            <el-radio value="user">指定用户</el-radio>
            <el-radio value="department">指定组织（部门及其下级）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="sendMode === 'user'" label="接收用户" required>
          <el-select
            v-model="sendForm.userIds"
            multiple
            filterable
            placeholder="选择已绑定登录账号的用户"
            style="width: 100%"
          >
            <el-option
              v-for="u in userOptions"
              :key="u.accountId"
              :label="u.name"
              :value="u.accountId"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-else label="接收组织" required>
          <div class="dept-picker">
            <el-tree
              :data="deptTree"
              show-checkbox
              node-key="id"
              default-expand-all
              :props="{ label: 'name', children: 'children' }"
              @check="onDeptCheck"
            />
          </div>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input
            v-model="sendForm.title"
            maxlength="128"
            show-word-limit
            placeholder="请输入通知标题"
          />
        </el-form-item>
        <el-form-item label="级别">
          <el-select v-model="sendForm.level" style="width: 160px">
            <el-option
              v-for="(meta, key) in LEVEL_META"
              :key="key"
              :label="meta.label"
              :value="key"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="链接">
          <el-input
            v-model="sendForm.link"
            maxlength="512"
            placeholder="点击后跳转的地址（可选）"
          />
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="sendForm.content"
            type="textarea"
            :rows="5"
            placeholder="请输入通知内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sendVisible = false">取消</el-button>
        <el-button type="primary" :loading="sendSaving" @click="submitSendNotification"
          >发送</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.announcement-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow: hidden;
  background: var(--surface-primary);
}

/* ---- 页头 ---- */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 18px;
  flex-shrink: 0;
}
.page-title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  background: linear-gradient(90deg, #818cf8, #a78bfa, #60a5fa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-secondary,
.btn-primary,
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-secondary {
  padding: 8px 14px;
  border: 1px solid var(--border-medium);
  background: var(--surface-card);
  color: var(--foreground-muted);
}
.btn-secondary:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}
.btn-primary {
  padding: 8px 18px;
  border: none;
  background: #4f46e5;
  color: #fff;
  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
}
.btn-primary:hover {
  background: #4338ca;
}
.btn-ghost {
  padding: 6px 12px;
  border: 1px solid var(--border-medium);
  background: var(--surface-card);
  color: var(--foreground-muted);
}
.btn-ghost:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

/* ---- 内容卡片 ---- */
.content-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  overflow: hidden;
}
.manage-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 20px;
}
.manage-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.manage-tabs :deep(.el-tab-pane) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---- 工具栏 ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 0;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.search-wrap {
  position: relative;
  flex: 1;
  max-width: 320px;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-muted);
}
.search-input {
  width: 100%;
  padding: 7px 12px 7px 30px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-medium);
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color 0.15s ease;
}
.search-input::placeholder {
  color: var(--foreground-muted);
}
.search-input:focus {
  border-color: var(--color-accent);
}
.toolbar-count {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  white-space: nowrap;
}

/* ---- 表格 ---- */
.manage-table {
  flex: 1;
  min-height: 0;
}
.title-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.title-icon {
  flex-shrink: 0;
  color: #a5b4fc;
}
.title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.content-preview {
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}
.muted-text {
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}
.level-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
}
.read-tag {
  display: inline-flex;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  color: #10b981;
  background: rgba(16, 185, 129, 0.14);
}
.read-tag.unread {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.14);
}
.user-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.user-icon {
  flex-shrink: 0;
  color: var(--foreground-muted);
}
.ops {
  display: flex;
  align-items: center;
  gap: 2px;
}
.op-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: none;
  background: none;
  color: var(--foreground-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.op-btn:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}
.op-btn--publish:hover {
  color: #10b981;
}
.op-btn--danger:hover {
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
}

/* ---- 分页 ---- */
.pagination-row {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 16px;
  flex-shrink: 0;
}

/* ---- 发送通知 ---- */
.dept-picker {
  width: 100%;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  padding: 8px;
}

/* ---- 详情弹窗 ---- */
.detail-head {
  margin-bottom: 16px;
}
.detail-title {
  margin: 0 0 8px;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--foreground-primary);
}
.detail-meta {
  display: flex;
  gap: 8px;
}
.detail-desc {
  margin-bottom: 16px;
}
.detail-link {
  color: #60a5fa;
  word-break: break-all;
}
.detail-content {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  padding: 14px;
}
.detail-section-label {
  margin: 0 0 8px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}
.detail-body {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
</style>
