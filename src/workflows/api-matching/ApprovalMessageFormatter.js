/**
 * ApprovalMessageFormatter - Renders an approval request as user-facing
 * markdown. Presentation only; the approval lifecycle lives in ApprovalManager.
 */
export class ApprovalMessageFormatter {
  format(intent, apiCalls, userInput, timeoutMs) {
    return [
      this.formatHeader(intent.riskLevel),
      this.formatRequestDetails(userInput, intent),
      this.formatAPICalls(apiCalls),
      this.formatImpactAnalysis(intent, apiCalls),
      this.formatInstructions(timeoutMs)
    ].join('\n\n');
  }

  formatHeader(riskLevel) {
    const riskEmoji = {
      low: '🟢',
      medium: '🟡',
      high: '🔴'
    };

    return `🔔 **APPROVAL REQUIRED** ${riskEmoji[riskLevel] || '⚠️'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  formatRequestDetails(userInput, intent) {
    return `📝 **Original Request:** "${userInput}"

⚠️  **Risk Level:** ${intent.riskLevel?.toUpperCase() || 'UNKNOWN'}

🎯 **Intent Analysis:**
   • Action: ${intent.action}
   • Resource: ${intent.resource}
   • Targets: ${intent.entities?.join(', ') || 'None specified'}
   ${intent.conditions && Object.keys(intent.conditions).length > 0
     ? `• Conditions: ${JSON.stringify(intent.conditions, null, 2)}`
     : ''}`;
  }

  formatAPICalls(apiCalls) {
    let message = `📋 **Actions to be performed (${apiCalls.length} operation${apiCalls.length > 1 ? 's' : ''}):**`;

    apiCalls.forEach((call, index) => {
      message += `\n\n   ${index + 1}. ${call.description || 'API Call'}
      • Service: ${(call.service || 'api').toUpperCase()}
      • Endpoint: ${call.method} ${call.endpoint}`;

      if (call.pathParams) {
        message += `\n      • Target: ${Object.values(call.pathParams).join(', ')}`;
      }

      if (call.queryParams) {
        message += `\n      • Filters: ${JSON.stringify(call.queryParams)}`;
      }

      if (call.body) {
        const bodyStr = JSON.stringify(call.body, null, 8);
        message += `\n      • Changes:\n         ${bodyStr.split('\n').join('\n         ')}`;
      }
    });

    return message;
  }

  formatImpactAnalysis(intent, apiCalls) {
    let impact = `⚡ **Impact Analysis:**`;

    switch (intent.action) {
      case 'delete':
        impact += `
   • ⚠️  PERMANENT deletion of ${apiCalls.length} ${intent.resource}(s)
   • This action CANNOT be undone
   • All associated data will be removed
   • Dependent resources may be affected`;
        break;

      case 'disable':
        impact += `
   • 🔒 ${intent.resource} will be DISABLED for ${intent.entities?.length || apiCalls.length} target(s)
   • Affected users will lose access to this feature
   • Changes take effect immediately
   • Can be reversed by re-enabling`;
        break;

      case 'create':
        impact += `
   • ➕ ${apiCalls.length} new ${intent.resource}(s) will be created
   • Default permissions will be applied
   • Resources will be immediately available
   • May affect quotas or limits`;
        break;

      case 'update':
        impact += `
   • ✏️  ${apiCalls.length} ${intent.resource}(s) will be modified
   • Previous values will be overwritten
   • Changes are immediate
   • Some changes may trigger notifications`;
        break;

      default:
        impact += `
   • ${apiCalls.length} operation(s) will be performed
   • Changes may affect system state
   • Review details above carefully`;
    }

    impact += `\n   • 📝 All actions will be logged in audit trail`;

    return impact;
  }

  formatInstructions(timeoutMs) {
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **To approve:** Reply with "approve"
❌ **To reject:** Reply with "reject"

⏱️ This request will timeout in ${Math.round(timeoutMs / 60000)} minutes if no response is received.`;
  }
}

export default ApprovalMessageFormatter;
