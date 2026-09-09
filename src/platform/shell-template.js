/**
 * Admin shell markup — never present in the initial HTML document.
 * Mounted into #platformShellHost only after platform-api whoami succeeds.
 */
export function buildPlatformShellHtml() {
  return `
<div id="platformShell" class="stack">
  <div class="shell-top">
    <div>
      <span class="badge">PLATFORM · SUPERADMIN</span>
      <h2 style="margin:0;">مدیریت سازمان‌ها</h2>
    </div>
    <button type="button" class="secondary" id="platformLogoutBtn">خروج</button>
  </div>

  <section class="card">
    <h2>خلاصه تنظیمات</h2>
    <ul id="platformDefaultsSummary"></ul>
  </section>

  <div class="grid grid-2">
    <section class="card">
      <h2>فهرست tenantها</h2>
      <div class="toolbar">
        <input id="platformTenantSearch" type="search" placeholder="جستجو: نام، slug، id، ساب‌دامین">
        <button type="button" class="secondary" id="platformRefreshTenantsBtn">بروزرسانی</button>
      </div>
      <ul id="platformTenantList"></ul>
    </section>

    <section class="card">
      <h2>ساخت سازمان (دستی)</h2>
      <form id="platformCreateForm">
        <label for="newTenantName">نام سازمان</label>
        <input id="newTenantName" required placeholder="مثلاً فروشگاه نمونه">
        <label for="newTenantOwnerPhone">موبایل مالک (اختیاری)</label>
        <input id="newTenantOwnerPhone" placeholder="09xxxxxxxxx">
        <label for="newTenantPlan">پلن اولیه</label>
        <select id="newTenantPlan">
          <option value="trial">آزمایشی</option>
          <option value="gold">طلایی</option>
          <option value="diamond">الماسی</option>
        </select>
        <button type="submit">ایجاد</button>
      </form>
      <div id="platformCreateStatus" class="status" hidden></div>
    </section>

    <section class="card">
      <h2>تغییر پلن / وضعیت اشتراک (دستی)</h2>
      <form id="platformSubForm">
        <label for="subTenantId">شناسه tenant</label>
        <input id="subTenantId" required placeholder="uuid سازمان">
        <label for="subPlanId">پلن</label>
        <select id="subPlanId">
          <option value="trial">آزمایشی</option>
          <option value="gold">طلایی</option>
          <option value="diamond">الماسی</option>
        </select>
        <label for="subStatus">وضعیت</label>
        <select id="subStatus">
          <option value="trialing">trialing</option>
          <option value="active">active</option>
          <option value="grace">grace</option>
          <option value="readonly">readonly</option>
          <option value="suspended">suspended</option>
        </select>
        <label for="subEndsInDays">مدت اعتبار از امروز (روز) — فقط وقتی وضعیت active است</label>
        <input id="subEndsInDays" type="number" min="1" value="30">
        <button type="submit">اعمال</button>
      </form>
      <div id="platformSubStatus" class="status" hidden></div>
    </section>

    <section class="card">
      <h2>پرداخت دستی + لیست پرداخت‌ها</h2>
      <form id="platformManualPayForm">
        <label for="manualTenantId">شناسه tenant</label>
        <input id="manualTenantId" required>
        <label for="manualPlanId">پلن</label>
        <select id="manualPlanId">
          <option value="gold">طلایی</option>
          <option value="diamond">الماسی</option>
        </select>
        <label for="manualPeriod">دوره</label>
        <select id="manualPeriod">
          <option value="monthly">ماهانه</option>
          <option value="yearly">سالانه</option>
        </select>
        <label for="manualAmount">مبلغ (ریال)</label>
        <input id="manualAmount" type="number" min="1" step="1" required placeholder="مثلاً 1500000">
        <label for="manualNote">یادداشت / شماره پیگیری</label>
        <input id="manualNote" placeholder="واریز کارت به کارت ...">
        <button type="submit">ثبت پرداخت دستی و فعال‌سازی</button>
      </form>
      <div id="platformManualPayStatus" class="status" hidden></div>
      <div class="toolbar" style="margin-top:12px;">
        <select id="platformPaymentStatusFilter" aria-label="فیلتر وضعیت پرداخت">
          <option value="">همه وضعیت‌ها</option>
          <option value="manual">manual</option>
          <option value="paid">paid</option>
          <option value="pending">pending</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
        <button type="button" class="secondary" id="platformRefreshPaymentsBtn">بروزرسانی پرداخت‌ها</button>
      </div>
      <ul id="platformPaymentsList" style="margin-top:12px;"></ul>
    </section>

    <section class="card">
      <h2>ساب‌دامین / آرشیو سازمان</h2>
      <form id="platformSubdomainForm">
        <label for="opsTenantId">شناسه tenant</label>
        <input id="opsTenantId" required placeholder="uuid">
        <label for="opsSubdomain">ساب‌دامین (مثلاً acme)</label>
        <input id="opsSubdomain" dir="ltr" placeholder="acme">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="submit">تنظیم ساب‌دامین</button>
          <button type="button" class="secondary" id="platformClearSubdomainBtn">حذف ساب‌دامین</button>
          <button type="button" class="secondary" id="platformArchiveTenantBtn" style="border-color:var(--danger);color:var(--danger);">آرشیو سازمان</button>
          <button type="button" class="secondary" id="platformUnarchiveTenantBtn">خروج از آرشیو</button>
        </div>
        <p style="color:var(--muted);font-size:0.8rem;margin-top:10px;line-height:1.5;">
          سوپرادمین می‌تواند ساب‌دامین را حتی بدون پلن الماسی تنظیم کند؛ در آن حالت هشدار تأیید نشان داده می‌شود.
        </p>
      </form>
      <div id="platformOpsStatus" class="status" hidden></div>
      <button type="button" class="secondary" id="platformRefreshAuditBtn" style="margin-top:12px;">نمایش audit (۱۰۰ مورد اخیر)</button>
      <ul id="platformAuditList" style="margin-top:12px;font-size:0.82rem;"></ul>
    </section>
  </div>

  <section class="card">
    <h2>تنظیمات پلتفرم</h2>
    <form id="platformSettingsForm" class="grid grid-2">
      <div>
        <label for="settingTrialDays">روزهای Trial</label>
        <input id="settingTrialDays" type="number" min="1" step="1">
      </div>
      <div>
        <label for="settingGraceDays">روزهای grace</label>
        <input id="settingGraceDays" type="number" min="0" step="1">
      </div>
      <div>
        <label for="settingRootDomain">دامنه ریشه ساب‌دامین</label>
        <input id="settingRootDomain" dir="ltr" placeholder="carno.ir">
      </div>
      <div>
        <label for="settingSubdomainMinLength">حداقل طول ساب‌دامین</label>
        <input id="settingSubdomainMinLength" type="number" min="1" max="40" step="1">
      </div>
      <div>
        <label for="settingSmsTrial">سقف SMS/روز — Trial</label>
        <input id="settingSmsTrial" type="number" min="0" step="1">
      </div>
      <div>
        <label for="settingSmsGold">سقف SMS/روز — طلایی</label>
        <input id="settingSmsGold" type="number" min="0" step="1">
      </div>
      <div>
        <label for="settingSmsDiamond">سقف SMS/روز — الماسی</label>
        <input id="settingSmsDiamond" type="number" min="0" step="1">
      </div>
      <div style="grid-column:1/-1;">
        <button type="submit">ذخیره تنظیمات</button>
      </div>
    </form>
    <div id="platformSettingsStatus" class="status" hidden></div>
  </section>
</div>
`.trim()
}
