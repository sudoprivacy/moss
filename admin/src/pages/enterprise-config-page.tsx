'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { getEnterpriseConfig, updateEnterpriseConfig, uploadLogo } from '@/lib/api/enterprise'
import type { EnterpriseConfig } from '@/lib/api/types'
import {
  Building2,
  Image as ImageIcon,
  Save,
  Upload,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ComponentType, ReactNode } from 'react'

type SettingsSectionProps = {
  icon: ComponentType<{ className?: string }>
  title: string
  description?: string
  children?: ReactNode
}

type SettingsFieldProps = {
  label: string
  description?: string
  children: ReactNode
}

function SettingSection({
  icon: Icon,
  title,
  description,
  children,
}: SettingsSectionProps) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span>{title}</span>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children ? <CardContent className="space-y-5 pt-6">{children}</CardContent> : null}
    </Card>
  )
}

function SettingField({
  label,
  description,
  children,
}: SettingsFieldProps) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:items-start md:gap-6">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      {[...Array(2)].map((_, index) => (
        <Card key={index}>
          <CardHeader className="border-b">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            {[...Array(3)].map((__, fieldIndex) => (
              <div key={fieldIndex} className="grid gap-3 md:grid-cols-[240px_1fr] md:gap-6">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-40" />
                </div>
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default function EnterpriseConfigPage() {
  const [config, setConfig] = useState<EnterpriseConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const response = await getEnterpriseConfig()
      if (response.success) {
        setConfig(response.data)
      } else {
        toast.error('获取企业配置失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '获取企业配置失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    try {
      const response = await uploadLogo(file)
      if (response.success) {
        const newLogoUrl = response.data.url
        // Update database immediately
        const updateResponse = await updateEnterpriseConfig({ logo: newLogoUrl })
        if (updateResponse.success) {
          setConfig(updateResponse.data)
          toast.success('Logo 上传并更新成功')
        } else {
          toast.error('Logo 更新到配置失败')
        }
      } else {
        toast.error('Logo 上传失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Logo 上传失败')
    } finally {
      setIsUploading(false)
    }
  }

  const handleSaveTextInfo = async () => {
    if (!config) return

    setIsSaving(true)
    try {
      const { logo, ...textFields } = config
      const response = await updateEnterpriseConfig(textFields)
      if (response.success) {
        setConfig(response.data)
        toast.success('配置保存成功')
      } else {
        toast.error('配置保存失败')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '配置保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleInputChange = (field: keyof EnterpriseConfig, value: string) => {
    setConfig(prev => prev ? { ...prev, [field]: value } : null)
  }

  if (isLoading) {
    return (
      <DashboardLayout
        title="企业信息配置"
        description="管理企业的 Logo、应用名称及相关描述信息。"
      >
        <SettingsSkeleton />
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout
      title="企业信息配置"
      description="管理企业的 Logo、应用名称及相关描述信息。"
    >
      <div className="space-y-6">
        <SettingSection
          icon={ImageIcon}
          title="Logo 配置"
          description="上传并设置企业的 Logo 图标。"
        >
          <SettingField label="当前 Logo" description="Logo 预览。建议使用透明背景的图片。">
            <div className="flex flex-col gap-4">
              <div className="flex h-24 w-24 items-center justify-center rounded-lg border bg-muted/20 overflow-hidden">
                {config?.logo ? (
                  <img
                    src={config.logo}
                    alt="Logo"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <div className="text-xs text-muted-foreground text-center px-2">暂无 Logo</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="relative" disabled={isUploading}>
                  {isUploading ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 size-4" />
                  )}
                  {isUploading ? '上传中...' : '上传 Logo'}
                  <input
                    type="file"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    disabled={isUploading}
                  />
                </Button>
              </div>
            </div>
          </SettingField>
        </SettingSection>

        <SettingSection
          icon={Building2}
          title="文字信息表单"
          description="配置应用名称、描述以及公司名称等文字信息。"
        >
          <SettingField label="应用名称 (app_name)" description="平台的正式名称。">
            <Input
              value={config?.app_name || ''}
              onChange={(e) => handleInputChange('app_name', e.target.value)}
              placeholder="请输入应用名称"
            />
          </SettingField>

          <SettingField label="顶部显示名称 (top_name)" description="显示在页面顶部的简短名称。">
            <Input
              value={config?.top_name || ''}
              onChange={(e) => handleInputChange('top_name', e.target.value)}
              placeholder="请输入顶部显示名称"
            />
          </SettingField>

          <SettingField label="关于页面名称 (about_name)" description="关于页面显示的标题。">
            <Input
              value={config?.about_name || ''}
              onChange={(e) => handleInputChange('about_name', e.target.value)}
              placeholder="请输入关于页面名称"
            />
          </SettingField>

          <SettingField label="公司名称 (app_company_name)" description="版权信息或公司主体名称。">
            <Input
              value={config?.app_company_name || ''}
              onChange={(e) => handleInputChange('app_company_name', e.target.value)}
              placeholder="请输入公司名称"
            />
          </SettingField>

          <SettingField label="登录页描述 (login_desp)" description="登录页面显示的介绍文字。">
            <Input
              value={config?.login_desp || ''}
              onChange={(e) => handleInputChange('login_desp', e.target.value)}
              placeholder="请输入登录页描述"
            />
          </SettingField>

          <div className="flex justify-end pt-4">
            <Button onClick={handleSaveTextInfo} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              保存
            </Button>
          </div>
        </SettingSection>
      </div>
    </DashboardLayout>
  )
}
