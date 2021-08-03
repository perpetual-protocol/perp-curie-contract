pragma solidity 0.7.6;

interface ISettlement {
    function settle(address account) external returns (int256 pnl);
}
