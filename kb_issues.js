const item = $input.first().json;

const kb = [
    // ─────────────────────────────────────────────
    // GENERAL ERRORS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Page or record not found',
        short_resolution_or_hint: 'The item you are looking for does not exist or may have been removed. Please double-check the link, or make sure the company, facility, or contact has been created first.',
        example_subjects: ['Company not found', 'Facility not found', 'Signatory not found', 'Page not found']
    },
    {
        short_issue: 'Session expired or not logged in',
        short_resolution_or_hint: 'Your login session has expired. Please log out and log back in to continue.',
        example_subjects: ['User not logged in', 'Token expired', 'Session timed out', 'Please log in again']
    },
    {
        short_issue: 'You do not have permission to do this',
        short_resolution_or_hint: 'Your account does not have the required access for this action. Please contact your admin or manager to get the right permissions assigned to your role.',
        example_subjects: ['Unauthorized access', 'Insufficient privileges', 'Role not assigned', 'Permission denied']
    },
    {
        short_issue: 'Missing or incorrect information in the form',
        short_resolution_or_hint: 'Some required fields are missing or filled incorrectly. Please review the highlighted fields and make sure all mandatory information (like PAN, name, address, etc.) is filled in correctly.',
        example_subjects: ['Required field is missing', 'Invalid PAN format', 'Company short name is empty', 'Address is not complete']
    },
    {
        short_issue: 'Something went wrong on our end',
        short_resolution_or_hint: 'We encountered an unexpected error while processing your request. Please try again after a few minutes. If the issue continues, reach out to support.',
        example_subjects: ['Could not fetch details at the moment', 'Could not create record at the moment', 'Server error']
    },

    // ─────────────────────────────────────────────
    // COMPANY ONBOARDING
    // ─────────────────────────────────────────────
    {
        short_issue: 'Unable to create a company',
        short_resolution_or_hint: 'Please make sure you have filled in the company name, short name, full registered address (including state), and CIN or GSTIN where applicable.',
        example_subjects: ['Company short name is empty', 'Company registered address is empty', 'State not found']
    },
    {
        short_issue: 'CIN number could not be verified',
        short_resolution_or_hint: 'The CIN (Company Identification Number) could not be verified. Please double-check the CIN and try again. If the problem persists, the verification service may be temporarily down.',
        example_subjects: ['CIN verification failed', 'Invalid CIN number', 'CIN lookup did not return results']
    },
    {
        short_issue: 'GST number could not be verified',
        short_resolution_or_hint: 'The GSTIN you entered could not be verified. Please check if the GST number is correct and in the right format (e.g., 22AAAAA0000A1Z5). If correct, the verification service may be temporarily unavailable — try again shortly.',
        example_subjects: ['GSTIN not found', 'GST verification failed', 'Invalid GSTIN format']
    },
    {
        short_issue: 'Unable to assign brand or portfolio to company',
        short_resolution_or_hint: 'The company needs a valid brand and portfolio (like Retail Lending, SME, etc.) to proceed. Make sure these are selected. Note: the portfolio cannot be changed once a facility is created.',
        example_subjects: ['Brand not assigned to company', 'Portfolio not found', 'Cannot change portfolio after facility creation']
    },

    // ─────────────────────────────────────────────
    // KYC / SIGNATORY
    // ─────────────────────────────────────────────
    {
        short_issue: 'Authorized signatory not found',
        short_resolution_or_hint: 'We could not find a signatory with the given PAN for this company. Please add the signatory first or double-check that the PAN number you entered is correct.',
        example_subjects: ['Signatory with PAN not found', 'Signatory PAN mismatch', 'No signatory linked to this company']
    },
    {
        short_issue: 'CKYC verification failed',
        short_resolution_or_hint: 'The CKYC (Central KYC) verification could not be completed. Please make sure the OTP was entered correctly and that the PAN/Aadhaar details are accurate. If you did not receive the OTP, try requesting it again.',
        example_subjects: ['CKYC OTP expired', 'CKYC search returned no results', 'CKYC verification error', 'CKYC card download failed']
    },
    {
        short_issue: 'CIBIL report could not be fetched',
        short_resolution_or_hint: 'The credit report (CIBIL) could not be generated. Please ensure the signatory\'s PAN, date of birth, and address are completely and correctly filled in. If everything looks right, the credit bureau service may be temporarily unavailable.',
        example_subjects: ['CIBIL fetch failed', 'Incomplete signatory details for CIBIL', 'Credit report not available']
    },
    {
        short_issue: 'Background verification failed',
        short_resolution_or_hint: 'The background/crime check for the signatory could not be completed. Please verify the signatory details are correct. If the problem continues, the verification service may be temporarily down.',
        example_subjects: ['Crime check error', 'Background verification pending', 'Verification timed out']
    },

    // ─────────────────────────────────────────────
    // FACILITY / TRANCHE / DISBURSEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Unable to create a facility',
        short_resolution_or_hint: 'Facility creation requires the company to exist with a portfolio assigned, and you must select a facility type (like Vendor Finance, Receivable Finance, Term Loan, etc.) along with the amount and tenure.',
        example_subjects: ['Facility type is required', 'Facility type not supported', 'Company does not have a portfolio']
    },
    {
        short_issue: 'Tranche creation or update failed',
        short_resolution_or_hint: 'The tranche must be linked to an approved facility with a borrower assigned. Please check that the tranche amount does not exceed the sanctioned limit and all dates are correctly filled.',
        example_subjects: ['Tranche amount exceeds facility limit', 'Facility not in approved state', 'Borrower not assigned to facility']
    },
    {
        short_issue: 'Disbursement could not be processed',
        short_resolution_or_hint: 'Disbursement requires the facility and tranche to be approved, bank account details to be verified, and all pre-disbursement checks to be completed. Please review the checklist and resolve any pending items.',
        example_subjects: ['Disbursement pre-checks failed', 'Bank account not verified', 'Loan setup not completed']
    },
    {
        short_issue: 'Bank account verification (penny drop) failed',
        short_resolution_or_hint: 'We could not verify the bank account. Please check that the IFSC code and account number are correct. If they are, the bank verification service may be temporarily down — try again shortly.',
        example_subjects: ['Penny drop failed', 'Invalid IFSC code', 'Bank verification timed out']
    },

    // ─────────────────────────────────────────────
    // DOCUMENTS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Document upload failed',
        short_resolution_or_hint: 'The file could not be uploaded. Please check that the file is in a supported format (PDF, JPG, PNG, Excel) and is within the size limit. Try uploading again after a moment.',
        example_subjects: ['File upload timed out', 'Unsupported file format', 'Upload error']
    },
    {
        short_issue: 'Document details do not match records',
        short_resolution_or_hint: 'The information on the uploaded document (like PAN, Aadhaar, or GST number) does not match the details saved in the system. Please make sure you are uploading the correct document for the right person or company.',
        example_subjects: ['PAN on document does not match', 'Aadhaar name mismatch', 'GST number mismatch']
    },

    // ─────────────────────────────────────────────
    // APPROVALS & WORKFLOWS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Workflow is not moving forward',
        short_resolution_or_hint: 'The workflow may be waiting for a required condition to be met or an action to be completed. Please check if all prerequisite steps are done before trying to proceed.',
        example_subjects: ['Workflow step not advancing', 'Required condition not met', 'Action button not working']
    },
    {
        short_issue: 'Approval is stuck or pending',
        short_resolution_or_hint: 'The approval is waiting for the designated approver to take action. Please check with your approver (checker/manager) or verify that the correct person is assigned as the approver for this step.',
        example_subjects: ['Approval pending', 'Waiting for checker', 'Approval not completed']
    },
    {
        short_issue: 'Did not receive approval or workflow email',
        short_resolution_or_hint: 'The expected email notification was not received. Please check your spam/junk folder. If it is not there, the notification may be delayed — wait a few minutes and check again. If it still does not arrive, contact support.',
        example_subjects: ['Approval email not received', 'Email notification missing', 'Did not get workflow update email']
    },

    // ─────────────────────────────────────────────
    // ACCOUNT AGGREGATOR (BANK DATA CONSENT)
    // ─────────────────────────────────────────────
    {
        short_issue: 'Account Aggregator consent failed',
        short_resolution_or_hint: 'The bank data consent process could not be completed. Please make sure you clicked the consent link, entered the correct OTP, and completed the process before it timed out. You can request a new consent link and try again.',
        example_subjects: ['Consent link expired', 'Session timed out', 'Wrong OTP entered', 'Consent was cancelled']
    },
    {
        short_issue: 'Bank data not available after giving consent',
        short_resolution_or_hint: 'Even though consent was given, the bank data could not be fetched. This can happen if the bank is not responding or the consent has not been fully processed yet. Please wait a few minutes and try again.',
        example_subjects: ['Bank data not available', 'Bank statement fetch failed', 'Data retrieval timed out']
    },

    // ─────────────────────────────────────────────
    // BANK STATEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Bank statement could not be analysed',
        short_resolution_or_hint: 'The uploaded bank statement could not be processed. Please make sure it is a valid bank statement in a supported format (PDF or Excel). Password-protected files should be unlocked before uploading.',
        example_subjects: ['Bank statement parsing error', 'Unsupported bank statement format', 'Statement analysis failed']
    },

    // ─────────────────────────────────────────────
    // COLLECTIONS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Cannot assign a customer for collection',
        short_resolution_or_hint: 'The customer may already be assigned to another agent or their current status does not allow reassignment. Only customers with status New, Live, or Reopen can be assigned.',
        example_subjects: ['Customer already assigned', 'Cannot assign closed customer', 'Assignment not allowed']
    },
    {
        short_issue: 'Unable to submit collection feedback',
        short_resolution_or_hint: 'Please make sure you have selected a valid feedback type (like Promise to Pay, Settlement, Payment Received, etc.) and filled in all required details such as the expected date or amount.',
        example_subjects: ['Invalid feedback type', 'Promise to Pay date missing', 'Feedback submission failed']
    },
    {
        short_issue: 'Collection payment not going through',
        short_resolution_or_hint: 'The payment could not be recorded or is waiting for approval. Please verify the payment mode and amount, and check if anchor/manager approval is needed for this payment.',
        example_subjects: ['Payment approval pending', 'Settlement rejected', 'Payment amount exceeds outstanding']
    },
    {
        short_issue: 'Dunning / reminder letter not generated',
        short_resolution_or_hint: 'The reminder letter could not be created. Please make sure the customer\'s address and contact details are complete. If everything looks correct, try again or contact support.',
        example_subjects: ['Letter generation failed', 'Incomplete customer address', 'Reminder email not sent']
    },

    // ─────────────────────────────────────────────
    // CREDIT RATING
    // ─────────────────────────────────────────────
    {
        short_issue: 'Credit rating could not be calculated',
        short_resolution_or_hint: 'The rating could not be generated because some financial information is incomplete. Please fill in all required financial details (like revenue, expenses, liabilities) and promoter information before trying again.',
        example_subjects: ['Financial data incomplete', 'Rating could not be generated', 'Missing promoter details']
    },
    {
        short_issue: 'Dropdown options not loading on rating form',
        short_resolution_or_hint: 'The selection options on the rating form are not loading. Please refresh the page and try again. If the issue persists, contact support.',
        example_subjects: ['Could not fetch drop down values', 'Rating form options empty', 'Dropdown not loading']
    },

    // ─────────────────────────────────────────────
    // AI CALLING
    // ─────────────────────────────────────────────
    {
        short_issue: 'Lead file upload for AI calling failed',
        short_resolution_or_hint: 'The lead file could not be uploaded. Please ensure it is in the correct format (CSV or Excel) with all required columns (phone number, name). Also check for duplicate phone numbers in the file.',
        example_subjects: ['File format invalid', 'Duplicate phone numbers', 'Upload failed']
    },
    {
        short_issue: 'AI calls are not being placed',
        short_resolution_or_hint: 'The AI calling system was unable to initiate calls. This could be due to a configuration issue or the calling service being temporarily unavailable. Please contact support if calls are not going out.',
        example_subjects: ['Calls not being made', 'AI calling error', 'Call initiation failed']
    },
    {
        short_issue: 'Call result or status not showing',
        short_resolution_or_hint: 'The result of the AI call has not been received yet. Call results may take a few minutes to appear. Please refresh the page and wait. If the status does not update after some time, contact support.',
        example_subjects: ['Call status missing', 'Disposition not available', 'Call result not updated']
    },
    {
        short_issue: 'Campaign retry calls not happening',
        short_resolution_or_hint: 'Retry calls for the campaign are not being triggered. Please check the campaign settings to ensure retry rules (number of retries, delay between retries, calling hours) are properly configured.',
        example_subjects: ['Retry calls not triggered', 'Campaign schedule issue', 'Retries exhausted but calls pending']
    },

    // ─────────────────────────────────────────────
    // NOTIFICATIONS (EMAIL / SMS / WHATSAPP)
    // ─────────────────────────────────────────────
    {
        short_issue: 'Email not received',
        short_resolution_or_hint: 'The expected email was not delivered. Please check your spam or junk folder. Also verify that the email address on file is correct. If you still do not see it after a few minutes, contact support.',
        example_subjects: ['Email not received', 'Notification email missing', 'Invalid email address']
    },
    {
        short_issue: 'SMS not received',
        short_resolution_or_hint: 'The SMS was not delivered. Please ensure the mobile number saved in the system is correct and has network coverage. If the number is correct, the message may be delayed — wait a few minutes.',
        example_subjects: ['SMS not delivered', 'Wrong mobile number', 'OTP not received']
    },
    {
        short_issue: 'WhatsApp message not received',
        short_resolution_or_hint: 'The WhatsApp message was not delivered. Please make sure the phone number (with country code) is correct and that the number is registered on WhatsApp. Check your WhatsApp inbox including the "Unknown" messages section.',
        example_subjects: ['WhatsApp message not received', 'Message not delivered', 'Phone number not on WhatsApp']
    },

    // ─────────────────────────────────────────────
    // REPORTS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Report is not loading',
        short_resolution_or_hint: 'The report could not be loaded. Please refresh the page and try again. If the report still does not load, the reporting service may be temporarily down — try again after a few minutes or contact support.',
        example_subjects: ['Report not loading', 'Blank report page', 'Report timed out']
    },
    {
        short_issue: 'File or report download is taking too long',
        short_resolution_or_hint: 'Large exports can take a while to generate. Try applying filters to reduce the amount of data, or download smaller date ranges. If it still fails, contact support for assistance.',
        example_subjects: ['Export timed out', 'Excel download failed', 'Report download hanging']
    },

    // ─────────────────────────────────────────────
    // COVENANTS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Covenant reminder not received',
        short_resolution_or_hint: 'The covenant due date reminder was not sent. Please verify that the covenant is set up correctly for the facility with the right due date. If it is, contact support to check the notification schedule.',
        example_subjects: ['Covenant reminder not sent', 'Covenant overdue alert missing', 'No notification for covenant']
    },

    // ─────────────────────────────────────────────
    // DROPDOWNS & FORM OPTIONS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Dropdown or form options not loading',
        short_resolution_or_hint: 'Some dropdown menus or selection options on the form are not showing up. Please refresh the page. If the issue continues, try clearing your browser cache or contact support.',
        example_subjects: ['Dropdown is empty', 'Options not loading', 'Form fields blank']
    },

    // ─────────────────────────────────────────────
    // LOGIN & ACCESS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Unable to log in',
        short_resolution_or_hint: 'Please check your username and password. If you have forgotten your password, use the reset password option. If your account is locked or disabled, contact your admin.',
        example_subjects: ['Login failed', 'Wrong password', 'Account locked', 'Cannot access the system']
    },
    {
        short_issue: 'Assigned role or team not showing correctly',
        short_resolution_or_hint: 'Your role or team does not seem right. Please contact your admin to verify that the correct role and team have been assigned to your account.',
        example_subjects: ['Role not found', 'Wrong team assigned', 'Cannot see assigned cases']
    },

    // ─────────────────────────────────────────────
    // LINKS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Shared link is not working',
        short_resolution_or_hint: 'The link you received (via SMS, WhatsApp, or email) may have expired or is not loading correctly. Please request a new link. If the problem continues, contact support.',
        example_subjects: ['Link expired', 'Short URL not working', 'Redirect not working']
    }
];

return [{
    json: {
        ...item,
        kb
    }
}];
