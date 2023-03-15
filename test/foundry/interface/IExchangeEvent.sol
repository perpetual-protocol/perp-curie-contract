pragma solidity 0.7.6;

interface IExchangeEvent {
    event FundingUpdated(address indexed baseToken, uint256 markTwap, uint256 indexTwap);
    event MaxTickCrossedWithinBlockChanged(address indexed baseToken, uint24 maxTickCrossedWithinBlock);
    event AccountBalanceChanged(address accountBalance);
    event PriceBandChanged(address indexed baseToken, uint24 priceBand);
}
