extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token, vec, Address, Env, String};

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    admin: Address,
    token: Address,
    disallowed_token: Address,
    creator: Address,
    verifier: Address,
    guardian: Address,
    success: Address,
    failure: Address,
    contract_id: Address,
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let other_token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);
    let (disallowed_token, _) = create_token(&env, &other_token_admin);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    contract.init(&admin);

    Setup {
        env,
        contract,
        admin,
        token,
        disallowed_token,
        creator,
        verifier,
        guardian,
        success,
        failure,
        contract_id,
    }
}

fn milestones(env: &Env) -> Vec<Milestone> {
    vec![
        env,
        Milestone {
            title: String::from_str(env, "m1"),
            amount: 500,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ]
}

fn create_vault_with_token(s: &Setup, token: &Address, vault_id: &str) -> Result<(), Error> {
    s.contract
        .try_create_vault(
            &String::from_str(&s.env, vault_id),
            &s.creator,
            &s.verifier,
            token,
            &500,
            &s.success,
            &s.failure,
            &1_100,
            &milestones(&s.env),
            &s.guardian,
        )
        .unwrap()
}

#[test]
fn init_rejects_second_admin_initialization() {
    let s = setup();
    let other = Address::generate(&s.env);

    let result = s.contract.try_init(&other).unwrap();

    assert_eq!(result, Err(Error::AdminAlreadyInitialized));
}

#[test]
fn non_admin_cannot_update_token_allowlist() {
    let s = setup();
    let not_admin = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_allowed_token(&not_admin, &s.token, &true)
        .unwrap();

    assert_eq!(result, Err(Error::NotAdmin));
    assert!(!s.contract.is_allowed_token(&s.token));
}

#[test]
fn admin_can_add_and_remove_allowed_token() {
    let s = setup();

    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    assert!(s.contract.is_allowed_token(&s.token));

    s.contract.set_allowed_token(&s.admin, &s.token, &false);
    assert!(!s.contract.is_allowed_token(&s.token));
}

#[test]
fn create_vault_rejects_token_when_allowlist_empty() {
    let s = setup();

    let result = create_vault_with_token(&s, &s.token, "v1");

    assert_eq!(result, Err(Error::TokenNotAllowed));
}

#[test]
fn create_vault_rejects_token_not_in_allowlist() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);

    let result = create_vault_with_token(&s, &s.disallowed_token, "v1");

    assert_eq!(result, Err(Error::TokenNotAllowed));
}

#[test]
fn create_vault_accepts_allowed_token_and_stake_uses_that_token() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);

    create_vault_with_token(&s, &s.token, "v1").expect("allowed token should create vault");
    let vault = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(vault.status, VaultStatus::Draft);
    assert_eq!(vault.token, s.token);

    s.contract
        .stake(&String::from_str(&s.env, "v1"), &s.creator);
    let vault = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
    assert_eq!(token_client.balance(&s.contract_id), 500);
}

// ── #493: deterministic vault address derivation ──────────────────────────────
//
// The backend (src/services/soroban.ts) deploys one AccountabilityVault
// contract per vault and must correlate the on-chain address to the off-chain
// PersistedVault.id before the transaction is confirmed.
//
// Soroban derives contract addresses deterministically from (deployer, salt):
//
//   address = sha256("contract" || deployer_bytes || salt_bytes)
//
// This means the address can be predicted *before* deployment using:
//   env.deployer().with_address(deployer, salt).deployed_address()
//
// Salt convention used by the backend:
//   BytesN<32> = sha256(vault_id_string) — a 32-byte hash of the off-chain UUID
//   (see src/services/soroban.ts: saltFromVaultId)
//
// These tests exercise and document the pattern so the backend deploy flow can
// be validated and the address correlation logic can be unit-tested off-chain.

#[test]
fn removing_token_blocks_new_vaults_but_preserves_existing_vault() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    create_vault_with_token(&s, &s.token, "v1").expect("allowed token should create vault");

    s.contract.set_allowed_token(&s.admin, &s.token, &false);
    let result = create_vault_with_token(&s, &s.token, "v2");

    assert_eq!(result, Err(Error::TokenNotAllowed));
    let existing = s.contract.get_vault(&String::from_str(&s.env, "v1"));
    assert_eq!(existing.token, s.token);
}

#[test]
fn create_vault_rejects_more_than_max_milestones() {
    let s = setup();
    s.contract.set_allowed_token(&s.admin, &s.token, &true);
    let mut milestones = Vec::new(&s.env);
    for i in 0..(MAX_MILESTONES + 1) {
        milestones.push_back(Milestone {
            title: String::from_str(&s.env, "m"),
            amount: 1,
            due_date: 1_100 + u64::from(i),
            verified: false,
            released: false,
        });
    }

    let result = s
        .contract
        .try_create_vault(
            &String::from_str(&s.env, "v1"),
            &s.creator,
            &s.verifier,
            &s.token,
            &i128::from(MAX_MILESTONES + 1),
            &s.success,
            &s.failure,
            &2_000,
            &milestones,
            &s.guardian,
        )
        .unwrap();

    assert_eq!(result, Err(Error::TooManyMilestones));
}

// ── pre-init paths ───────────────────────────────────────────────────────────

#[test]
fn test_get_vault_not_initialized() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");

    let result = contract.try_get_vault(&vault_id);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_stake_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let creator = Address::generate(&env);

    let result = contract.try_stake(&vault_id, &creator);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_check_in_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let verifier = Address::generate(&env);

    let result = contract.try_check_in(&vault_id, &verifier, &0);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_claim_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "v1");
    let creator = Address::generate(&env);

    let result = contract.try_claim(&vault_id, &creator);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[cfg(test)]
mod scval_i128_parity_tests {
    use super::*;
    use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

    fn assert_scval_i128_roundtrip(env: &Env, amount: i128) {
        // Encodes the native i128 value into a Soroban Val type
        let encoded_val: Val = amount.into_val(env);
        
        // Decodes it back out to guarantee the format matches backend expectations
        let decoded_amount: i128 = i128::try_from_val(env, &encoded_val)
            .expect("Parity Gap: Unable to decode structural i128 asset value.");
            
        assert_eq!(amount, decoded_amount, "Parity Gap: Value changed during roundtrip conversion.");
    }

    #[test]
    fn test_lifecycle_events_i128_parity() {
        let env = Env::default();
        
        // Test zero, standard token scales, and large balance amounts
        assert_scval_i128_roundtrip(&env, 0);                               // Base case
        assert_scval_i128_roundtrip(&env, 100_000_000);                     // Stake / Slash amount
        assert_scval_i128_roundtrip(&env, 5_000_000_000);                   // Claim amount
        assert_scval_i128_roundtrip(&env, 123_456_789_012_345_678_901_i128); // High volume cap bounds
    }
}
