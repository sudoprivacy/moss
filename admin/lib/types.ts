// 用户类型
export interface User {
  id: string
  username: string
  email: string
  role: 'admin' | 'dept_admin' | 'user'
  apiKey: string
  createdAt: string
  lastLogin: string
  status: 'active' | 'inactive'
  permissions: {
    skills: string[]
    assistants: string[]
  }
}

// Session 类型
export interface Session {
  id: string
  userId: string
  username: string
  assistant: string
  startTime: string
  endTime: string | null
  messageCount: number
  tokensUsed: number
  status: 'active' | 'completed'
}

// 消息类型
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  tokens: number
}

// 统计数据类型
export interface DailyStats {
  date: string
  sessions: number
  tokens: number
  users: number
}

export interface UserStats {
  userId: string
  username: string
  sessions: number
  tokens: number
}
