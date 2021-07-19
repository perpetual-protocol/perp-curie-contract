pragma solidity 0.7.6;

// TODO probably need to rename
interface ISettlement {
    // clear debt by remaining balance and return pnl
    // (quote.available - quote.debt)
    function settle(address account) external returns (int256 pnl);

    // negative means unrealized pnl
    function getRequiredCollateral(address account) external view returns (int256);
}
