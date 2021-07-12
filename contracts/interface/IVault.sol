pragma solidity 0.7.6;

interface IVault {
    // just for test, TODO remove later
    function settlementToken() external returns (address);

    function deposit(
        address from,
        address token,
        uint256 amount
    ) external;

    function realizeProfit(address account, uint256 profit) external;

    function realizeLoss(address account, uint256 loss) external;

    function balanceOf(address account) external view returns (uint256);

    function decimals() external view returns (uint8);
}
