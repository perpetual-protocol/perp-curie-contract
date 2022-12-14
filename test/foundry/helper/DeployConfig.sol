pragma solidity 0.7.6;

contract DeployConfig {
    // ClearinghouseConfig
    uint8 public constant MAX_MARKETS_PER_ACCOUNT = 5;
    uint256 public constant SETTLEMENT_TOKEN_BALANCE_CAP = 1000000;

    // MarketRegistry
    uint8 public constant MAX_ORDERS_PER_MARKET = 3;

    // UniswapV3Pool
    uint24 internal constant _DEFAULT_POOL_FEE = 3000;

    // BaseToken Market
    string internal constant _BASE_TOKEN_NAME = "vETH";
    string internal constant _BASE_TOKEN_2_NAME = "vBTC";
    string internal constant _QUOTE_TOKEN_NAME = "vUSD";

    // CollateralManager
    uint8 internal constant _MAX_COLLATERAL_TOKENS_PER_ACCOUNT = 3;
    uint24 internal constant _DEBT_NON_SETTLEMENT_TOKEN_VALUE_RATIO = 0.75e6; // 75%
    uint24 internal constant _LIQUIDATION_RATIO = 0.5e6; // 50%
    uint24 internal constant _MAINTENANCE_MARGIN_RATIO_BUFFER = 0.005e6; // 0.5%
    uint24 internal constant _CL_INSURANCE_FUND_FEE_RATIO = 0.0125e6; // 1.25%
    uint256 internal constant _DEBT_THRESHOLD = 10000; // decimal agnostic
    uint256 internal constant _COLLATERAL_VALUE_DUST = 350; // decimal agnostic
}
