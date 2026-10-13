import { randomUUID } from 'node:crypto'
import type { DbDriver } from '../db/driver.js'
import type { AuthService } from '../auth/service.js'
import { ParkApiError } from './parkAuthorization.js'
import { ParkAuditService } from './parkAuditService.js'
import { ParkRepository } from './parkRepository.js'

/**
 * Prospect enterprise registration (plan 2.3): phone + SMS code + enterprise
 * name + contact (+ optional park invite code). Creates a new enterprise org,
 * its first user, the park profiles/binding (prospect, bound to the invite's
 * park or the deployment default park). The existing /api/v1/auth/register
 * and invitations flow is untouched.
 */
export class ParkRegistrationService {
  private readonly repo: ParkRepository
  private readonly audit: ParkAuditService

  constructor(
    private readonly driver: DbDriver,
    private readonly authService: AuthService,
  ) {
    this.repo = new ParkRepository(driver)
    this.audit = new ParkAuditService(driver)
  }

  async registerEnterprise(input: {
    phone: string
    smsCode: string
    enterpriseName: string
    contactName: string
    inviteToken?: string | null
  }): Promise<{
    enterprise_org_id: string
    park_org_id: string
    user_id: string
  }> {
    const phone = input.phone.trim()
    const enterpriseName = input.enterpriseName.trim()
    const contactName = input.contactName.trim()
    if (!phone || !enterpriseName || !contactName) {
      throw new ParkApiError(400, 'invalid_payload', 'phone、enterprise_name、contact_name 均为必填')
    }

    // 1. SMS verification (reuses the phone_login_codes path).
    let verified = false
    try {
      verified = await this.authService.phoneAuth.verifyCode(phone, input.smsCode)
    } catch {
      verified = false
    }
    if (!verified) {
      throw new ParkApiError(401, 'sms_code_invalid', '验证码错误或已过期')
    }

    // 2. Duplicate phone → explicit error (existing users must log in).
    const existing = await this.authService.findUserByPhone(phone)
    if (existing) {
      throw new ParkApiError(409, 'phone_already_registered', '该手机号已注册，请直接登录')
    }

    // 3. Resolve the target park: invite code's org, else the default park.
    const parkOrgId = await this.resolveParkOrgId(input.inviteToken ?? null)

    // 4. Create org + first user through the existing identity services.
    const created = await this.authService.createOrganization({ name: enterpriseName })
    const enterpriseOrgId = String((created.organization as { id: string }).id)
    const createdUser = await this.authService.createUser({
      orgId: enterpriseOrgId,
      name: contactName,
      displayName: contactName,
      role: 'user',
      // Phone-code login users carry a random password they never need;
      // they authenticate via SMS codes on the existing login path.
      password: `pk-${randomUUID()}`,
      phone,
      status: 'active',
    })

    // 5. Park domain rows.
    await this.repo.upsertOrgProfile({
      mossOrgId: enterpriseOrgId,
      orgType: 'enterprise',
      displayName: enterpriseName,
    })
    await this.repo.upsertEnterpriseProfile({
      enterpriseOrgId,
      parkOrgId,
      enterpriseName,
      contactName,
      contactPhone: phone,
    })
    await this.repo.insertBinding({ parkOrgId, enterpriseOrgId, lifecycle: 'prospect' })
    await this.audit.record({
      parkOrgId,
      actorUserId: String(createdUser.user.id),
      actorOrgId: enterpriseOrgId,
      action: 'park.register_enterprise',
      targetType: 'enterprise_org',
      targetId: enterpriseOrgId,
      after: { enterpriseName, contactName, lifecycle: 'prospect' },
    })

    return { enterprise_org_id: enterpriseOrgId, park_org_id: parkOrgId, user_id: String(createdUser.user.id) }
  }

  private async resolveParkOrgId(inviteToken: string | null): Promise<string> {
    if (inviteToken && inviteToken.trim()) {
      const row = await this.driver.get<{ org_id: unknown }>(
        `SELECT org_id FROM invitations WHERE code = ? AND status = 'pending' LIMIT 1`,
        [inviteToken.trim()],
      )
      if (!row) {
        throw new ParkApiError(400, 'invite_invalid', '邀请码无效或已被使用')
      }
      return String(row.org_id)
    }
    const defaultPark = await this.repo.getDefaultParkOrgId()
    if (!defaultPark) {
      throw new ParkApiError(409, 'no_default_park', '园区尚未完成初始化（未设置默认园区），请联系园区运营')
    }
    return defaultPark
  }
}
