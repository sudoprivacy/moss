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

    return this.driver.transaction(async () => {
      const existing = await this.authService.findUserByPhone(phone)
      if (existing) {
        throw new ParkApiError(409, 'phone_already_registered', '该手机号已注册，请直接登录')
      }
      const target = await this.resolvePark(input.inviteToken ?? null)
      const parkOrgId = target.parkOrgId
      const created = await this.authService.createOrganization({ name: enterpriseName })
      const enterpriseOrgId = String((created.organization as { id: string }).id)
      const createdUser = await this.authService.createUser({
        orgId: enterpriseOrgId,
        // A contact name is a display name, not a globally unique login name.
        name: `park-${randomUUID()}`,
        displayName: contactName,
        role: 'user',
        password: `pk-${randomUUID()}`,
        phone,
        status: 'active',
      })
      await this.authService.putOrganizationClientPolicy(
        enterpriseOrgId,
        { loginMethod: 'sms', loginMethodInherited: false },
        String(createdUser.user.id),
      )
      await this.repo.upsertOrgProfile({ mossOrgId: enterpriseOrgId, orgType: 'enterprise', displayName: enterpriseName })
      await this.repo.upsertEnterpriseProfile({ enterpriseOrgId, parkOrgId, enterpriseName, contactName, contactPhone: phone })
      await this.repo.insertBinding({ parkOrgId, enterpriseOrgId, lifecycle: 'prospect' })
      if (target.invitationId) {
        const changed = await this.driver.run(
          `UPDATE invitations SET status = 'used', used_by_user_id = ?, used_at = ? WHERE id = ? AND status = 'pending'`,
          [String(createdUser.user.id), Date.now(), target.invitationId],
        )
        if (changed !== 1) throw new ParkApiError(400, 'invite_invalid', '邀请码无效或已被使用')
      }
      await this.audit.record({
        parkOrgId, actorUserId: String(createdUser.user.id), actorOrgId: enterpriseOrgId,
        action: 'park.register_enterprise', targetType: 'enterprise_org', targetId: enterpriseOrgId,
        after: { enterpriseName, contactName, lifecycle: 'prospect' },
      })
      return { enterprise_org_id: enterpriseOrgId, park_org_id: parkOrgId, user_id: String(createdUser.user.id) }
    })
  }

  private async resolvePark(inviteToken: string | null): Promise<{ parkOrgId: string; invitationId: string | null }> {
    if (inviteToken && inviteToken.trim()) {
      const row = await this.driver.get<{ id: string; org_id: string }>(
        `SELECT i.id, i.org_id FROM invitations i
         JOIN park_org_profiles p ON p.moss_org_id = i.org_id AND p.org_type = 'park'
         WHERE i.code = ? AND i.status = 'pending' LIMIT 1`,
        [inviteToken.trim()],
      )
      if (!row) {
        throw new ParkApiError(400, 'invite_invalid', '邀请码无效或已被使用')
      }
      return { parkOrgId: String(row.org_id), invitationId: String(row.id) }
    }
    const defaultPark = await this.repo.getDefaultParkOrgId()
    if (!defaultPark) {
      throw new ParkApiError(409, 'no_default_park', '园区尚未完成初始化（未设置默认园区），请联系园区运营')
    }
    return { parkOrgId: defaultPark, invitationId: null }
  }
}
