// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IClearingHouseConfigEvent {
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);

    event PartialCloseRatioChanged(uint24 partialCloseRatio);

    event TwapIntervalChanged(uint256 twapInterval);

    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);

    event SettlementTokenBalanceCapChanged(uint256 cap);

    event MaxFundingRateChanged(uint24 rate);

    event MarkPriceMarketTwapIntervalChanged(uint32 twapInterval);

    event MarkPricePremiumIntervalChanged(uint32 premiumInterval);
}

interface IClearingHouseConfig is IClearingHouseConfigEvent {
    /// @return maxMarketsPerAccount Max value of total markets per account
    function getMaxMarketsPerAccount() external view returns (uint8 maxMarketsPerAccount);

    /// @return imRatio Initial margin ratio
    function getImRatio() external view returns (uint24 imRatio);

    /// @return mmRatio Maintenance margin requirement ratio
    function getMmRatio() external view returns (uint24 mmRatio);

    /// @return liquidationPenaltyRatio Liquidation penalty ratio
    function getLiquidationPenaltyRatio() external view returns (uint24 liquidationPenaltyRatio);

    /// @notice **Deprecated function, will be removed in later release**
    /// @return partialCloseRatio Partial close ratio
    function getPartialCloseRatio() external view returns (uint24 partialCloseRatio);

    /// @return twapInterval TwapInterval for funding and prices (market & index) calculations
    function getTwapInterval() external view returns (uint32 twapInterval);

    /// @return settlementTokenBalanceCap Max value of settlement token balance
    function getSettlementTokenBalanceCap() external view returns (uint256 settlementTokenBalanceCap);

    /// @return maxFundingRate Max value of funding rate
    function getMaxFundingRate() external view returns (uint24 maxFundingRate);

    /// @return marketTwapInterval MarketTwapInterval is the interval of market twap used for mark price calculations
    /// @return premiumInterval PremiumInterval is the interval of premium used for mark price calculations
    function getMarkPriceConfig() external view returns (uint32 marketTwapInterval, uint32 premiumInterval);
}
