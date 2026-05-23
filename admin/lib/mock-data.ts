import type { User, Session, Message, DailyStats, UserStats } from './types'

// 模拟用户数据
export const mockUsers: User[] = [
  {
    id: '1',
    username: '张三',
    email: 'zhangsan@company.com',
    role: 'admin',
    apiKey: 'sk-xxxx-xxxx-xxxx-1234',
    createdAt: '2024-01-15',
    lastLogin: '2024-03-20 14:30',
    status: 'active',
    permissions: {
      skills: ['code-gen', 'data-analysis', 'text-writing'],
      assistants: ['assistant-1', 'assistant-2', 'assistant-3'],
    },
  },
  {
    id: '2',
    username: '李四',
    email: 'lisi@company.com',
    role: 'user',
    apiKey: 'sk-xxxx-xxxx-xxxx-5678',
    createdAt: '2024-02-01',
    lastLogin: '2024-03-19 09:15',
    status: 'active',
    permissions: {
      skills: ['code-gen', 'text-writing'],
      assistants: ['assistant-1'],
    },
  },
  {
    id: '3',
    username: '王五',
    email: 'wangwu@company.com',
    role: 'user',
    apiKey: 'sk-xxxx-xxxx-xxxx-9012',
    createdAt: '2024-02-15',
    lastLogin: '2024-03-18 16:45',
    status: 'active',
    permissions: {
      skills: ['data-analysis'],
      assistants: ['assistant-2'],
    },
  },
  {
    id: '4',
    username: '赵六',
    email: 'zhaoliu@company.com',
    role: 'dept_admin',
    apiKey: 'sk-xxxx-xxxx-xxxx-3456',
    createdAt: '2024-03-01',
    lastLogin: '2024-03-15 11:00',
    status: 'inactive',
    permissions: {
      skills: [],
      assistants: ['assistant-1'],
    },
  },
  {
    id: '5',
    username: '钱七',
    email: 'qianqi@company.com',
    role: 'user',
    apiKey: 'sk-xxxx-xxxx-xxxx-7890',
    createdAt: '2024-03-10',
    lastLogin: '2024-03-20 10:20',
    status: 'active',
    permissions: {
      skills: ['code-gen', 'data-analysis', 'text-writing'],
      assistants: ['assistant-1', 'assistant-2'],
    },
  },
]

// 模拟 Session 数据
export const mockSessions: Session[] = [
  {
    id: 'sess-001',
    userId: '1',
    username: '张三',
    assistant: 'GPT-4 助手',
    startTime: '2024-03-20 14:00',
    endTime: '2024-03-20 14:30',
    messageCount: 12,
    tokensUsed: 2450,
    status: 'completed',
  },
  {
    id: 'sess-002',
    userId: '1',
    username: '张三',
    assistant: '代码助手',
    startTime: '2024-03-20 15:00',
    endTime: null,
    messageCount: 5,
    tokensUsed: 890,
    status: 'active',
  },
  {
    id: 'sess-003',
    userId: '2',
    username: '李四',
    assistant: 'GPT-4 助手',
    startTime: '2024-03-20 09:00',
    endTime: '2024-03-20 09:45',
    messageCount: 8,
    tokensUsed: 1650,
    status: 'completed',
  },
  {
    id: 'sess-004',
    userId: '3',
    username: '王五',
    assistant: '数据分析助手',
    startTime: '2024-03-19 16:00',
    endTime: '2024-03-19 17:30',
    messageCount: 20,
    tokensUsed: 4200,
    status: 'completed',
  },
  {
    id: 'sess-005',
    userId: '5',
    username: '钱七',
    assistant: 'GPT-4 助手',
    startTime: '2024-03-20 10:00',
    endTime: '2024-03-20 10:20',
    messageCount: 6,
    tokensUsed: 1120,
    status: 'completed',
  },
]

// 模拟消息数据
export const mockMessages: Message[] = [
  {
    id: 'msg-001',
    sessionId: 'sess-001',
    role: 'user',
    content: '请帮我分析一下这段代码的性能问题',
    timestamp: '2024-03-20 14:00:05',
    tokens: 25,
  },
  {
    id: 'msg-002',
    sessionId: 'sess-001',
    role: 'assistant',
    content: '好的，我来分析一下这段代码。首先，我注意到在循环中有多次不必要的数据库查询...',
    timestamp: '2024-03-20 14:00:15',
    tokens: 180,
  },
  {
    id: 'msg-003',
    sessionId: 'sess-001',
    role: 'user',
    content: '如何优化这个循环查询？',
    timestamp: '2024-03-20 14:01:00',
    tokens: 15,
  },
  {
    id: 'msg-004',
    sessionId: 'sess-001',
    role: 'assistant',
    content: '您可以考虑使用批量查询来优化。具体做法是：1. 先收集所有需要查询的ID...',
    timestamp: '2024-03-20 14:01:20',
    tokens: 220,
  },
  {
    id: 'msg-005',
    sessionId: 'sess-001',
    role: 'user',
    content: '能给我一个具体的代码示例吗？',
    timestamp: '2024-03-20 14:02:00',
    tokens: 18,
  },
  {
    id: 'msg-006',
    sessionId: 'sess-001',
    role: 'assistant',
    content: '当然，这是优化后的代码示例...\n\n```javascript\nconst ids = items.map(item => item.id);\nconst results = await db.query(\'SELECT * FROM table WHERE id IN (?)\', [ids]);\n```',
    timestamp: '2024-03-20 14:02:30',
    tokens: 150,
  },
]

// 模拟每日统计数据
export const mockDailyStats: DailyStats[] = [
  { date: '03-14', sessions: 45, tokens: 12500, users: 8 },
  { date: '03-15', sessions: 52, tokens: 15800, users: 10 },
  { date: '03-16', sessions: 38, tokens: 9200, users: 6 },
  { date: '03-17', sessions: 61, tokens: 18900, users: 12 },
  { date: '03-18', sessions: 55, tokens: 16500, users: 11 },
  { date: '03-19', sessions: 48, tokens: 14200, users: 9 },
  { date: '03-20', sessions: 67, tokens: 21000, users: 14 },
]

// 模拟用户统计数据
export const mockUserStats: UserStats[] = [
  { userId: '1', username: '张三', sessions: 156, tokens: 45000 },
  { userId: '2', username: '李四', sessions: 89, tokens: 28500 },
  { userId: '3', username: '王五', sessions: 67, tokens: 21000 },
  { userId: '5', username: '钱七', sessions: 45, tokens: 15800 },
  { userId: '4', username: '赵六', sessions: 12, tokens: 3200 },
]

// Skill 列表
export const skillOptions = [
  { value: 'code-gen', label: '代码生成' },
  { value: 'data-analysis', label: '数据分析' },
  { value: 'text-writing', label: '文本写作' },
  { value: 'image-gen', label: '图像生成' },
  { value: 'translation', label: '翻译服务' },
]

// Assistant 列表
export const assistantOptions = [
  { value: 'assistant-1', label: 'GPT-4 助手' },
  { value: 'assistant-2', label: '代码助手' },
  { value: 'assistant-3', label: '数据分析助手' },
  { value: 'assistant-4', label: '写作助手' },
]
