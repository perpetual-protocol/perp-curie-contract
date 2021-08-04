pragma solidity 0.7.6;

interface IVault {
    function balanceOf(address account) external view returns (uint256);

    function decimals() external view returns (uint8);
}
