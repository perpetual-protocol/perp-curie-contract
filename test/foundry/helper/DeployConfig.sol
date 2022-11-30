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
}
