pragma solidity 0.7.6;

interface IClearingHouseConfigEvent {
    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);
    event SettlementTokenBalanceCapChanged(uint256 cap);
    event MaxFundingRateChanged(uint24 rate);
    event BackstopLiquidityProviderChanged(address indexed account, bool indexed isProvider);
    event MarketMaxPriceSpreadRatioChanged(address indexed baseToken, uint24 spreadRatio);
}
