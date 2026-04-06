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
    },

    // ─────────────────────────────────────────────
    // LMS ONBOARDING (Loan Management System Setup)
    // ─────────────────────────────────────────────
    {
        short_issue: 'LMS office creation failed',
        short_resolution_or_hint: 'The LMS office could not be created because the company\'s registered address is incomplete (street, city, or PIN missing) or the state could not be mapped. Please ensure the company has a full address including state, and try again.',
        example_subjects: ['State ID not found for the company', 'Address is not complete for the company', 'LMS office creation error']
    },
    {
        short_issue: 'LMS operation blocked — office not created yet',
        short_resolution_or_hint: 'Several LMS operations (like adding bank details, creating a product, or onboarding a borrower) require the LMS office to be created first. Please ensure the LMS office has been set up before proceeding.',
        example_subjects: ['No office ID found', 'Office not set up', 'LMS setup incomplete']
    },
    {
        short_issue: 'LMS office config update failed',
        short_resolution_or_hint: 'The office configuration could not be updated. Please ensure a facility is selected, the anchor open limit is set on the facility, and the Team Lead (TL) and Relationship Manager (RM) are assigned to the company.',
        example_subjects: ['No facility selected', 'Anchor open limit not found', 'TL or RM account not selected']
    },
    {
        short_issue: 'LMS product creation failed',
        short_resolution_or_hint: 'The LMS product could not be created. This can happen if the facility short name is empty, the product already exists, or mandatory facility parameters (like discounting tenor, program limit, or rate of interest) are missing. Please fill in all required facility details.',
        example_subjects: ['Facility short name is empty', 'Product already created', 'Mandatory parameters not found', 'No parameter configuration found']
    },
    {
        short_issue: 'LMS product partially updated',
        short_resolution_or_hint: 'The product was created or updated on LMS, but a follow-up step (like updating tenure frequency, syncing product config, or activating the retailer) failed. Please try re-syncing the product or contact support.',
        example_subjects: ['Product created but failed to update tenure frequency', 'EMI details updated but failed to update product config', 'Product updated but failed to sync']
    },
    {
        short_issue: 'LMS bank details could not be added',
        short_resolution_or_hint: 'Bank details could not be synced to LMS. Please ensure the account number, IFSC code, and beneficiary name are all filled in. Also check that the bank details have not already been added to LMS and that the account type is valid.',
        example_subjects: ['Bank details are incomplete', 'Bank details already exist on LMS', 'Invalid account type']
    },
    {
        short_issue: 'LMS agreement template generation failed',
        short_resolution_or_hint: 'The system could not generate or approve the agreement template on LMS. Please ensure all required facility and borrower details are complete, then try again. If this persists, contact support.',
        example_subjects: ['Failed to generate agreement template', 'Failed to approve sections', 'Agreement creation error']
    },
    {
        short_issue: 'LMS client already exists',
        short_resolution_or_hint: 'A client record has already been created on LMS for this company. You cannot create a duplicate. If the existing record is incorrect, contact support for assistance.',
        example_subjects: ['Client already exists for the company', 'Duplicate client creation', 'LMS client exists']
    },
    {
        short_issue: 'LMS term loan creation failed',
        short_resolution_or_hint: 'The term loan could not be created. Make sure the LMS client has been created first, the loan doesn\'t already exist for this facility, and the facility has a portfolio assigned.',
        example_subjects: ['Client does not exist for the company', 'Loan already exists for the company', 'No portfolio ID found']
    },
    {
        short_issue: 'Lender commitment is in draft state',
        short_resolution_or_hint: 'The lender commitment (colending/co-investment) is still in draft and cannot be submitted to LMS yet. Please ensure all commitment details are finalized before submitting.',
        example_subjects: ['Lender Commitment is in draft state', 'Cannot submit draft commitment', 'Commitment not finalized']
    },

    // ─────────────────────────────────────────────
    // LMS BORROWER ONBOARDING
    // ─────────────────────────────────────────────
    {
        short_issue: 'Borrower onboarding to LMS failed',
        short_resolution_or_hint: 'The borrower could not be onboarded on LMS. Common reasons: the company\'s incorporation type is not supported, incorporation date is missing, the proposed credit limit is not set, or mandatory parameters (like proposed limit, open limit, insurance amount) are missing. Please check all required fields.',
        example_subjects: ['Incorporation type not supported', 'Incorporation date is empty', 'Document limit is not available', 'Mandatory fields missing']
    },
    {
        short_issue: 'Borrower relation or details not found',
        short_resolution_or_hint: 'The system could not find the link between the anchor and the borrower company. Please ensure the business relation has been properly created before attempting LMS onboarding.',
        example_subjects: ['Borrower relation not found', 'Borrower detail not found', 'Borrower relation details not found']
    },
    {
        short_issue: 'Multiple portfolios found for borrower',
        short_resolution_or_hint: 'The borrower has more than one portfolio assigned, causing ambiguity in segment assignment. Please ensure only one portfolio is active for the borrower before proceeding.',
        example_subjects: ['Multiple portfolios found', 'Portfolio ambiguity', 'Cannot determine segment']
    },
    {
        short_issue: 'Associated entity for borrower is missing',
        short_resolution_or_hint: 'Borrower onboarding requires at least one associated entity (such as a co-borrower or guarantor) to be added to the company. Please add the associated entity before proceeding.',
        example_subjects: ['Please add associated entity for company', 'Co-borrower not added', 'Associated entity required']
    },
    {
        short_issue: 'CIN is required for anchor onboarding',
        short_resolution_or_hint: 'When board resolution signing is configured, the company\'s CIN (Corporate Identification Number) is mandatory for anchor onboarding. Please add the CIN to the company details and try again.',
        example_subjects: ['CIN is mandatory for anchor onboarding', 'CIN required for BR signing', 'Missing CIN for anchor']
    },
    {
        short_issue: 'Only TL can trigger LMS onboarding',
        short_resolution_or_hint: 'For agency model facilities, only a Team Lead (TL) is authorized to trigger LMS onboarding. Please ask your Team Lead to perform this action.',
        example_subjects: ['Only TL is authorized to perform Trigger to LMS', 'Permission denied for LMS trigger', 'TL authorization required']
    },

    // ─────────────────────────────────────────────
    // LMS CO-BORROWER / ASSOCIATED ENTITY ONBOARDING
    // ─────────────────────────────────────────────
    {
        short_issue: 'Co-borrower onboarding to LMS failed',
        short_resolution_or_hint: 'The co-borrower (associated entity) could not be onboarded. Please ensure: the parent loan has been created first, the co-borrower is not already onboarded, and all required fields (entity type, date of birth, phone number) are filled in.',
        example_subjects: ['Parent loan ID not found', 'Associated entity already onboarded', 'Associated entity type is mandatory', 'Associated entity dob is mandatory']
    },
    {
        short_issue: 'Co-borrower signing details missing',
        short_resolution_or_hint: 'The co-borrower\'s DIN (Director Identification Number) or Designation is required for document signing but has not been filled in. Please update the co-borrower details with DIN and Designation.',
        example_subjects: ['Missing DIN for coborrower', 'Missing Designation for coborrower', 'Signing details incomplete']
    },

    // ─────────────────────────────────────────────
    // COMPANY & COUNTERPARTY MANAGEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Portfolio is required for this action',
        short_resolution_or_hint: 'Most operations in the system require a portfolio to be selected or assigned. Please make sure the portfolio ID is provided in your request or that the company has a portfolio assigned.',
        example_subjects: ['Portfolio required', 'Portfolio id required', 'No portfolio assigned']
    },
    {
        short_issue: 'Form schema not found',
        short_resolution_or_hint: 'No form schema has been configured for the selected portfolio or entity type. This means the system does not know which fields to show. Please contact your admin to set up the form schema configuration.',
        example_subjects: ['Schema not found', 'Schema not found for Counter Party', 'Form configuration missing']
    },
    {
        short_issue: 'Counterparty data validation failed',
        short_resolution_or_hint: 'The counterparty data you submitted does not match the expected format or is missing required fields as per the configured schema. Please review all fields and ensure they comply with the validation rules.',
        example_subjects: ['Error in validating counter party data', 'Counterparty validation error', 'Data does not match schema']
    },
    {
        short_issue: 'Cannot edit record at this stage',
        short_resolution_or_hint: 'The record is currently in a workflow stage that does not allow editing. You may need to wait for the current approval/review step to complete before making changes.',
        example_subjects: ['Can not edit the details at this stage', 'Record locked for editing', 'Edit not allowed in current stage']
    },
    {
        short_issue: 'Bank account creation or update failed',
        short_resolution_or_hint: 'The bank account could not be created or updated. Please ensure a valid company is selected and all required bank details (account number, IFSC, account holder name) are correctly filled in.',
        example_subjects: ['Company id is required', 'Error in creating the bank account', 'Bank account validation error']
    },
    {
        short_issue: 'Virtual account creation or update failed',
        short_resolution_or_hint: 'The virtual account could not be created or updated due to validation errors. Please check that all required virtual account fields are properly filled. If deleting, make sure the account exists.',
        example_subjects: ['Error in creating the virtual account', 'Error in updating virtual accounts', 'Account not found']
    },
    {
        short_issue: 'Brand creation or update failed',
        short_resolution_or_hint: 'The brand could not be created or updated due to validation errors. Please check the brand name and other required fields are filled correctly.',
        example_subjects: ['Error in creating Brand', 'Error in updating brand', 'Brand validation error']
    },
    {
        short_issue: 'Industry contribution exceeds 100%',
        short_resolution_or_hint: 'The total contribution percentage for company industry mappings cannot exceed 100%. Please adjust the contribution values so they add up to 100% or less.',
        example_subjects: ['Total contribution cannot exceed 100%', 'Industry mapping error', 'Contribution percentage too high']
    },

    // ─────────────────────────────────────────────
    // WARRANTS / CCPS & DISBURSEMENT DETAILS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Warrant or CCPS creation failed',
        short_resolution_or_hint: 'Warrant or CCPS (Compulsorily Convertible Preference Shares) creation requires the maturity date to be provided. Please fill in all mandatory fields including the maturity date.',
        example_subjects: ['Maturity date required', 'Invalid CCPS/Warrants request', 'Error in creating the warrants']
    },
    {
        short_issue: 'Disbursement fields locked before partner approval',
        short_resolution_or_hint: 'Certain disbursement fields (like status, UTR Number, and UTR Date) cannot be added or modified until partner approval is received. Please wait for the partner approval to complete first.',
        example_subjects: ['Status, UTR Number, UTR Date can\'t be added before partner approval', 'Disbursement locked', 'Awaiting partner approval']
    },

    // ─────────────────────────────────────────────
    // EXCEL DATA UPLOAD & VALIDATION
    // ─────────────────────────────────────────────
    {
        short_issue: 'Date format error in uploaded file',
        short_resolution_or_hint: 'A date field in the uploaded Excel file is empty or in an incorrect format. Please use the yyyy-mm-dd format (e.g., 2025-01-15) for all date fields and try uploading again.',
        example_subjects: ['Date is empty or in an invalid format', 'Use yyyy-mm-dd format', 'Invalid date in Excel']
    },
    {
        short_issue: 'Reference data not found in uploaded file',
        short_resolution_or_hint: 'The uploaded file references a value (like a funding series, currency type, or category) that does not exist in the system. Please check that all reference values match the available options in the system.',
        example_subjects: ['Series not found', 'Currency Type not found', 'Invalid reference value']
    },
    {
        short_issue: 'Invalid number in uploaded file',
        short_resolution_or_hint: 'A field that requires a numeric value has text or an invalid entry. Please ensure all amount, quantity, and percentage fields contain valid numbers only.',
        example_subjects: ['Field should be a valid number', 'Non-numeric value in amount field', 'Number format error']
    },

    // ─────────────────────────────────────────────
    // RM ASSIGNMENT & AGENT MANAGEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Relationship Manager could not be assigned',
        short_resolution_or_hint: 'The system could not auto-assign a Relationship Manager to the company because no eligible users were found. Please ask your admin to configure RM users for this portfolio or team.',
        example_subjects: ['Users list is empty', 'Cannot assign RM', 'No eligible RM found']
    },
    {
        short_issue: 'Agent configuration incomplete for campaign',
        short_resolution_or_hint: 'The agent could not be assigned to the campaign. Please ensure at least one agent is selected and that each agent has their Flexi Dial username configured before mapping them to a campaign.',
        example_subjects: ['Agents can not be null', 'Set Flexy Dial Username for Agent first', 'Agent not configured']
    },

    // ─────────────────────────────────────────────
    // COLLECTION – COUNTERPARTY & DASHBOARD
    // ─────────────────────────────────────────────
    {
        short_issue: 'Bulk counterparty creation failed',
        short_resolution_or_hint: 'The batch counterparty creation could not be processed. Please ensure the secret key and customer list are provided and that a batch with the same secret key has not already been submitted.',
        example_subjects: ['Secret key and customers can not be None', 'Batch already exists with same secret key', 'Duplicate batch submission']
    },
    {
        short_issue: 'No relation between anchor and counterparty',
        short_resolution_or_hint: 'The system could not find a business relation linking the anchor company to the counterparty. This is required for dashboard data and other operations. Please ensure the counterparty is properly linked to the anchor company.',
        example_subjects: ['No relation exists between anchor and counterparty', 'Counterparty does not belong to this company', 'Business relation missing']
    },
    {
        short_issue: 'Organization ID not found for company',
        short_resolution_or_hint: 'The company does not have an organization ID set, which is required for collection operations and dashboard data. Please contact support to have the organization ID configured.',
        example_subjects: ['Organization id not found for provided anchor', 'No organization id found for company', 'Invalid or missing org_id']
    },
    {
        short_issue: 'Collection customer record not found',
        short_resolution_or_hint: 'No collection customer record was found for this counterparty. The counterparty may not have been properly onboarded into the collections system. Please ensure the counterparty has been created and linked.',
        example_subjects: ['Customer object not found for counterparty', 'Customer not found', 'No customer record']
    },
    {
        short_issue: 'Collection target data not available',
        short_resolution_or_hint: 'Collection target data could not be fetched. The collection targets may not have been configured for the selected time period. Please check the target configuration or contact your admin.',
        example_subjects: ['Could not fetch target data', 'Target not configured', 'No target for this period']
    },
    {
        short_issue: 'No collection feedback or customer state data found',
        short_resolution_or_hint: 'No feedback records or customer state data were found for the given filters. This could mean no collection activity has been recorded yet for these criteria. Try broadening your filter criteria.',
        example_subjects: ['No customer states found', 'No feedback records found', 'Empty collection data']
    },
    {
        short_issue: 'Collection dashboard summary generation failed',
        short_resolution_or_hint: 'The AI-powered collection dashboard summary could not be generated. This might be a temporary issue with the summary service. Please try again after a few minutes.',
        example_subjects: ['Failed to generate dashboard summary', 'Failed to generate counterparty dashboard summary', 'Summary service error']
    },
    {
        short_issue: 'Collection intelligence data could not be fetched',
        short_resolution_or_hint: 'The collection intelligence data could not be retrieved. Please verify the company ID and counterparty ID are valid and that the counterparty belongs to the specified company.',
        example_subjects: ['Invalid company id', 'Invalid counterparty_id', 'Intelligence data fetch failed']
    },

    // ─────────────────────────────────────────────
    // COLLECTION – AGENCY MANAGEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Collection agency creation failed',
        short_resolution_or_hint: 'The collection agency could not be created. An agency with the same PAN number may already exist, or the agency data is invalid. Please check the PAN number and all required agency details.',
        example_subjects: ['Agency with this PAN number already exists', 'Invalid agency data', 'Agency creation error']
    },
    {
        short_issue: 'Collection agency not found',
        short_resolution_or_hint: 'The collection agency you are trying to update or view does not exist. Please verify the agency ID and try again.',
        example_subjects: ['Collection agency does not exist', 'Agency not found', 'Invalid agency ID']
    },
    {
        short_issue: 'Unable to fetch team members',
        short_resolution_or_hint: 'The team member list could not be retrieved from the identity service. This may be a temporary connectivity issue. Please try again after a moment.',
        example_subjects: ['Failed to fetch team members', 'Team member list unavailable', 'Identity service error']
    },

    // ─────────────────────────────────────────────
    // AI CALLING – ADVANCED / CONFIGURATION
    // ─────────────────────────────────────────────
    {
        short_issue: 'AI calling template download failed',
        short_resolution_or_hint: 'The lead file template could not be downloaded. Please ensure you have selected a facility or facility type. If no Excel schema or dynamic variables are configured for this facility, contact your admin.',
        example_subjects: ['Either facility or facility_type is required', 'No configuration found for the specified facility', 'No excel schema configured']
    },
    {
        short_issue: 'AI calling bulk upload validation errors',
        short_resolution_or_hint: 'Some records in the uploaded lead file failed validation. Common issues include: invalid PAN format, invalid mobile number, future due dates, negative outstanding amounts, or negative DPD values. Please fix the flagged records and re-upload.',
        example_subjects: ['Invalid PAN format', 'Invalid mobile number format', 'Due date cannot be future date', 'Outstanding amount must be positive', 'DPD must be non-negative', 'Some records failed validation']
    },
    {
        short_issue: 'AI calling facility access denied',
        short_resolution_or_hint: 'You do not have tenant-level access to the selected facility for AI calling. Please contact your admin to grant you access to this facility.',
        example_subjects: ['Facility not found or access denied', 'Tenant access required', 'No access to this facility']
    },
    {
        short_issue: 'AI calling user not found',
        short_resolution_or_hint: 'Your user account could not be matched in the system. Please ensure your logged-in email address matches a registered user account.',
        example_subjects: ['User not found', 'Email does not match', 'User account not recognized']
    },
    {
        short_issue: 'AI calling batch processing error',
        short_resolution_or_hint: 'The lead batch could not be processed or submitted to the AI calling vendor. This could be due to an invalid secret key, missing batch ID, malformed data, or the vendor service being temporarily unavailable. Please try re-uploading or contact support.',
        example_subjects: ['Secret key required', 'Batch not found', 'Invalid secret key', 'Invalid data format', 'Failed to submit batch call']
    },
    {
        short_issue: 'Individual AI call could not be initiated',
        short_resolution_or_hint: 'The system could not place an individual AI call. Please ensure a calling configuration exists for the selected facility and that an agent is configured. If everything looks correct, the calling vendor may be temporarily unavailable.',
        example_subjects: ['No calling configuration found for facility', 'Failed to initiate individual call', 'No agent configured for this facility']
    },
    {
        short_issue: 'AI calling agent details could not be fetched',
        short_resolution_or_hint: 'The agent configuration details could not be retrieved from the AI calling vendor. Please make sure a facility is selected and that the vendor service is reachable.',
        example_subjects: ['facility_id is required', 'No agent configured for this facility', 'Failed to fetch agent details']
    },
    {
        short_issue: 'AI calling webhook processing failed',
        short_resolution_or_hint: 'A post-call webhook or call result could not be processed. This is usually a temporary issue. If call statuses or transcripts are not appearing, please wait a few minutes and refresh. Contact support if the issue persists.',
        example_subjects: ['Unsupported webhook type', 'Failed to process agent call webhook', 'Failed to process call initiation failure', 'Company ID or Batch ID missing in webhook']
    },
    {
        short_issue: 'AI calling retry could not be triggered',
        short_resolution_or_hint: 'A scheduled retry call could not be placed because the original call communication record was not found. This may happen if the original call data was deleted or corrupted. Please contact support.',
        example_subjects: ['Communication not found for retry', 'Retry call failed', 'Original call record missing']
    },

    // ─────────────────────────────────────────────
    // ENUMERATION & MASTER DATA MANAGEMENT
    // ─────────────────────────────────────────────
    {
        short_issue: 'Enumeration not found',
        short_resolution_or_hint: 'The requested enumeration (dropdown master data) does not exist or the name is incorrect. Please verify the enum name is correct. If you need a new enum to be added, contact your admin.',
        example_subjects: ['Please check if enum exists', 'Enumeration not found', 'Enum name incorrect']
    },
    {
        short_issue: 'Enum data not provided',
        short_resolution_or_hint: 'You tried to create or update enumeration values but did not provide the enum data. Please include the list of values when submitting.',
        example_subjects: ['Please provide enum data', 'Enum values missing', 'Empty enum submission']
    },

    // ─────────────────────────────────────────────
    // SYSTEM HEALTH & CONNECTIVITY
    // ─────────────────────────────────────────────
    {
        short_issue: 'System health check failed',
        short_resolution_or_hint: 'The system health check detected an issue — usually the database is temporarily unreachable. If you are experiencing slow performance or errors across the platform, the issue is likely being addressed. Please try again shortly.',
        example_subjects: ['Health check failed', 'Database unreachable', '502 Bad Gateway', 'System unavailable']
    },
    {
        short_issue: 'External service temporarily unavailable',
        short_resolution_or_hint: 'An external service (like CKYC, CIBIL, GST verification, Digitap, or a calling vendor) is temporarily not responding. Please wait a few minutes and retry the operation. If the issue persists beyond 30 minutes, contact support.',
        example_subjects: ['Digitap GST API error', 'Carma API error', 'Server error in calling carma api', 'External API timeout']
    },
    {
        short_issue: 'Background task or async processing failed',
        short_resolution_or_hint: 'A background process (like batch creation, data sync, or report generation) encountered an error. These tasks are retried automatically in most cases. If the expected result has not appeared after 15-20 minutes, contact support.',
        example_subjects: ['Error in updating communication records', 'Error processing lead batch', 'Counterparty batch creation failure', 'Async task failed']
    },

    // ─────────────────────────────────────────────
    // COVENANT COMPLIANCE BLOCKS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Operation blocked by covenant compliance',
        short_resolution_or_hint: 'An LMS operation (like office creation, product creation, or borrower onboarding) is blocked because a pre-agreement or pre-disbursal covenant condition has not been met. Please check if all covenants are fulfilled or if a deferral has been obtained.',
        example_subjects: ['Covenant condition not met', 'CP Pre-Agreement not fulfilled', 'CP Pre-Disbursal pending', 'Deferral not taken']
    },

    // ─────────────────────────────────────────────
    // TOKEN & AUTHENTICATION ISSUES
    // ─────────────────────────────────────────────
    {
        short_issue: 'Authentication token is missing or invalid',
        short_resolution_or_hint: 'Your request could not be authenticated because the token is missing, expired, or invalid. Please log out completely, clear your browser cache, and log in again. If you continue to face issues, contact support.',
        example_subjects: ['User not logged in', 'Token missing', 'Auth info empty', 'Invalid token']
    },
    {
        short_issue: 'Specific action privilege not granted',
        short_resolution_or_hint: 'Your user account does not have the specific privilege required for this action. Unlike general permissions, this is a fine-grained access check. Please ask your admin to assign the required privilege to your role.',
        example_subjects: ['Unauthorized access requested', 'Privilege not assigned', 'Action not allowed for your role']
    },

    // ─────────────────────────────────────────────
    // CUSTOM FORMS & SCHEMA
    // ─────────────────────────────────────────────
    {
        short_issue: 'Custom form submission failed',
        short_resolution_or_hint: 'The custom form could not be submitted because it did not pass validation against the configured schema. Please review all required fields and ensure the data types match (e.g., numbers in number fields, proper date formats).',
        example_subjects: ['Form validation error', 'Schema validation failed', 'Custom form data invalid']
    },
    {
        short_issue: 'Custom form schema not configured',
        short_resolution_or_hint: 'No form schema has been configured for this entity or portfolio. The form cannot be displayed without a schema. Please contact your admin to set up the form configuration.',
        example_subjects: ['Schema not configured', 'No form definition found', 'Form not available for this entity']
    },

    // ─────────────────────────────────────────────
    // DATA EXPORT & LARGE OPERATIONS
    // ─────────────────────────────────────────────
    {
        short_issue: 'Bulk operation partially failed',
        short_resolution_or_hint: 'Some records in the bulk operation were processed successfully while others failed. Please check the error details for each failed record, fix the issues, and retry only the failed records.',
        example_subjects: ['Partial batch failure', 'Some records failed', 'Batch processing errors']
    },
    {
        short_issue: 'Data sync between systems failed',
        short_resolution_or_hint: 'Data synchronization between our platform and an external system (like LMS) failed midway. Some data may have been partially updated. Please do not retry immediately — contact support to verify the current state before retrying.',
        example_subjects: ['Sync failed', 'Partial data update', 'LMS sync error', 'Data inconsistency']
    },

    // ─────────────────────────────────────────────
    // BROWSER & UI ISSUES
    // ─────────────────────────────────────────────
    {
        short_issue: 'Page is loading slowly or not responding',
        short_resolution_or_hint: 'If the page is loading slowly or appears frozen, try refreshing the page. Clear your browser cache and cookies if the issue persists. Using the latest version of Chrome or Edge is recommended for best performance.',
        example_subjects: ['Page not loading', 'Slow performance', 'Screen frozen', 'Spinner not stopping']
    },
    {
        short_issue: 'Button or action is not responding on click',
        short_resolution_or_hint: 'If a button or action does not respond when clicked, it may be disabled due to a pending prerequisite step, or there may be a validation error that is not visible. Please scroll through the form to check for any error messages, ensure all required fields are filled, and try again.',
        example_subjects: ['Button not working', 'Submit not responding', 'Action button disabled', 'Nothing happens on click']
    },
    {
        short_issue: 'Data not refreshing or showing stale information',
        short_resolution_or_hint: 'The data displayed may be cached. Please refresh the page using Ctrl+Shift+R (hard refresh) to load the latest data. If you just performed an action, wait a few seconds for the system to process it before refreshing.',
        example_subjects: ['Old data showing', 'Status not updated', 'Changes not reflected', 'Stale data displayed']
    },

    // ─────────────────────────────────────────────
    // DUPLICATE RECORD ISSUES
    // ─────────────────────────────────────────────
    {
        short_issue: 'Duplicate record error',
        short_resolution_or_hint: 'The record could not be created because a similar record already exists (e.g., same PAN, same company, same facility). Please search for the existing record instead of creating a new one. If you believe this is incorrect, contact support.',
        example_subjects: ['Duplicate PAN', 'Record already exists', 'Company already registered', 'Duplicate entry error']
    },

    // ─────────────────────────────────────────────
    // MOBILE / NETWORK ISSUES
    // ─────────────────────────────────────────────
    {
        short_issue: 'Operation failed due to network issues',
        short_resolution_or_hint: 'The operation could not be completed, possibly due to a weak or interrupted internet connection. Please check your network connection and try again. Avoid switching between Wi-Fi and mobile data during important operations.',
        example_subjects: ['Network error', 'Request timed out', 'Connection lost', 'Failed to fetch']
    },
    {
        short_issue: 'File download not starting',
        short_resolution_or_hint: 'The file download may be blocked by your browser or a pop-up blocker. Please allow pop-ups for this site in your browser settings and try again. Also check your Downloads folder in case the file was downloaded but not notified.',
        example_subjects: ['Download not starting', 'File not downloading', 'Pop-up blocked', 'Download blocked']
    }
];
return kb.map(entry => ({ json: entry }));