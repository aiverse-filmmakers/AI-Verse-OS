export const PURPOSE_OPTIONAL_OWNER_BACKED_DOMAINS = Object.freeze({
  risks: 'relevant_risk_domain_present',
  team_resources: 'relevant_team_resource_domain_present',
  customers: 'relevant_customer_domain_present',
  infrastructure: 'relevant_infrastructure_domain_present',
  budget_cost: 'relevant_budget_cost_domain_present',
});

export const PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES = Object.freeze(
  Object.keys(PURPOSE_OPTIONAL_OWNER_BACKED_DOMAINS),
);
